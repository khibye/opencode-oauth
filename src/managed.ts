import type { Plugin } from "@opencode/plugin/effect"
import { Duration, Effect, Queue, Schema, Stream } from "effect"
import { watch } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

// Keeps OpenCode's managed config in line with the organization's copy on the
// gateway, and tells the gateway which copy this machine runs.
//
// OpenCode loads `opencode.json` and then `opencode.jsonc` from its system
// directory, and either one can carry policies, so both are kept identical: a
// file a user drops beside ours is overwritten too. OpenCode watches that
// directory and reloads its config when a file in it changes.

export const fileNames = ["opencode.json", "opencode.jsonc"] as const

// Where OpenCode looks for managed config (its ConfigDiscovery.systemDirectory).
export function systemDirectory(platform = process.platform, env = process.env): string {
  if (platform === "darwin") return "/Library/Application Support/opencode"
  if (platform === "win32") return path.join(env.ProgramData || "C:\\ProgramData", "opencode")
  return "/etc/opencode"
}

const banner = "// Managed by your organization through opencode-oauth. Changes made here are replaced automatically.\n"

export function render(doc: Record<string, unknown>): Record<(typeof fileNames)[number], string> {
  const json = `${JSON.stringify(doc, null, 2)}\n`
  return { "opencode.json": json, "opencode.jsonc": banner + json }
}

const SettingsBody = Schema.Struct({
  checksum: Schema.NonEmptyString,
  settings: Schema.Record(Schema.String, Schema.Unknown),
})

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export type Fetched =
  | { readonly kind: "unchanged" }
  | { readonly kind: "none" }
  | { readonly kind: "settings"; readonly checksum: string; readonly etag: string | undefined; readonly doc: Record<string, unknown> | undefined }

const fetchTimeoutMs = 10_000

// GET the managed settings with the user's token. 304 keeps what we have; 404
// means the gateway has none, so there is nothing to enforce.
export function fetchSettings(url: string, accessToken: string, etag: string | undefined, key: string) {
  return Effect.tryPromise({
    try: async (signal): Promise<Fetched> => {
      const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }
      if (etag) headers["If-None-Match"] = etag
      const response = await fetch(url, {
        headers,
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(fetchTimeoutMs)]),
      })
      if (response.status === 304) return { kind: "unchanged" }
      if (response.status === 404) return { kind: "none" }
      if (!response.ok) throw new Error(`the managed settings endpoint answered ${response.status}`)
      const body = Schema.decodeUnknownSync(SettingsBody)(await response.json())
      const doc = body.settings[key]
      return {
        kind: "settings",
        checksum: body.checksum,
        etag: response.headers.get("ETag") ?? undefined,
        doc: isObject(doc) ? doc : undefined,
      }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
}

// Writes each file whose content differs, through a temporary file and a rename
// so OpenCode never reads half a file. Returns whether every file now matches.
export function ensureFiles(directory: string, content: Record<string, string>) {
  return Effect.tryPromise({
    try: async () => {
      let changed = false
      await mkdir(directory, { recursive: true })
      for (const [name, text] of Object.entries(content)) {
        const file = path.join(directory, name)
        const current = await readFile(file, "utf8").catch(() => undefined)
        if (current === text) continue
        const temporary = `${file}.${process.pid}.tmp`
        await writeFile(temporary, text, { mode: 0o644 })
        await rename(temporary, file)
        changed = true
      }
      return changed
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
}

export interface ManagedOptions {
  readonly settingsURL: string
  readonly key: string
  readonly directory: string
  readonly pollMs: number
}

export interface ManagedState {
  // The checksum the gateway gave for the copy this machine runs, or undefined
  // while the files don't match it (or nothing was fetched yet).
  checksum: string | undefined
  etag: string | undefined
  content: Record<string, string> | undefined
}

// One sync: fetch (or reuse) the organization's copy, then make the files on
// disk match it. A failed write leaves no checksum, so the gateway turns the
// requests away until the files are right again.
export function syncOnce(state: ManagedState, options: ManagedOptions, accessToken: string | undefined) {
  return Effect.gen(function* () {
    if (accessToken === undefined) return
    const fetched = yield* fetchSettings(
      options.settingsURL,
      accessToken,
      state.content ? state.etag : undefined,
      options.key,
    )
    let checksum = state.checksum
    if (fetched.kind === "none") {
      state.checksum = undefined
      state.etag = undefined
      state.content = undefined
      return
    }
    if (fetched.kind === "settings") {
      checksum = fetched.checksum
      state.etag = fetched.etag
      state.content = fetched.doc ? render(fetched.doc) : undefined
    }
    if (!state.content) {
      state.checksum = checksum
      return
    }
    const written = yield* ensureFiles(options.directory, state.content).pipe(
      Effect.map(() => true),
      Effect.catch((error) =>
        Effect.logWarning(
          `cannot write the managed config in ${options.directory} (${error.message}); ` +
            "requests to the gateway are refused until this user can write there",
        ).pipe(Effect.as(false)),
      ),
    )
    state.checksum = written ? checksum : undefined
  })
}

export const policyHeader = "x-org-policy"

export function enforceManaged(ctx: Plugin.Context, providerID: string, options: ManagedOptions) {
  return Effect.gen(function* () {
    const state: ManagedState = { checksum: undefined, etag: undefined, content: undefined }

    // Every model request to the gateway says which copy of the managed config it ran under.
    yield* ctx.session.hook(
      "model.request",
      (input) =>
        Effect.sync(() => {
          input.headers[policyHeader] = state.checksum ?? "none"
        }),
      { providerID },
    )

    const token = Effect.gen(function* () {
      const connection = yield* ctx.integration.connection.active(providerID)
      if (!connection) return undefined
      // resolve() renews a token that is about to expire.
      const credential = yield* ctx.integration.connection.resolve(connection)
      return credential?.type === "oauth" ? credential.access : undefined
    })

    const sync = Effect.gen(function* () {
      const accessToken = yield* token
      yield* syncOnce(state, options, accessToken)
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`managed config sync failed: ${error instanceof Error ? error.message : String(error)}`),
      ),
    )

    // Syncs run one at a time; a burst of triggers coalesces into one.
    const triggers = yield* Queue.sliding<void>(1)
    const trigger = Queue.offer(triggers, undefined)
    yield* Stream.fromQueue(triggers).pipe(Stream.runForEach(() => sync), Effect.forkScoped)

    // At sign-in or account switch.
    yield* ctx.event.subscribe({ types: ["credential.switched"] }).pipe(
      Stream.filter((event) => event.type === "credential.switched" && event.data.integrationID === providerID),
      Stream.runForEach(() => trigger),
      Effect.forkScoped({ startImmediately: true }),
    )

    // On a timer, to pick up the organization's changes.
    yield* Effect.forever(Effect.sleep(Duration.millis(options.pollMs)).pipe(Effect.andThen(trigger))).pipe(
      Effect.forkScoped,
    )

    // At once when someone changes a file in the managed directory.
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        try {
          return watch(options.directory, (_event, name) => {
            if (name === null || (fileNames as ReadonlyArray<string>).includes(String(name))) {
              Effect.runFork(trigger)
            }
          })
        } catch {
          // The directory does not exist yet; the first sync creates it and the timer covers the rest.
          return undefined
        }
      }),
      (watcher) => Effect.sync(() => watcher?.close()),
    )

    yield* trigger
  })
}
