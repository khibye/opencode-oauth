import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import plugin from "../src/index.js"
import { type ManagedOptions, type ManagedState, render, syncOnce } from "../src/managed.js"

// A stand-in for LiteLLM's GET /claude_code_gateway/managed/settings.
let settings: Record<string, unknown> | undefined = { opencode: { share: "disabled" } }
let checksum = "sha256:one"
const seen: Array<{ auth: string | null; ifNoneMatch: string | null }> = []
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      seen.push({ auth: request.headers.get("Authorization"), ifNoneMatch: request.headers.get("If-None-Match") })
      if (request.headers.get("Authorization") !== "Bearer good-token") return new Response(null, { status: 401 })
      if (!settings) return new Response(null, { status: 404 })
      const etag = `"${checksum}"`
      if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } })
      return Response.json({ uuid: checksum, checksum, settings }, { headers: { ETag: etag } })
    },
  })
})
afterAll(() => server.stop(true))

const url = () => `http://127.0.0.1:${server.port}/claude_code_gateway/managed/settings`
const fresh = (): ManagedState => ({ checksum: undefined, etag: undefined, content: undefined })
const optionsIn = async (): Promise<ManagedOptions> => ({
  settingsURL: url(),
  key: "opencode",
  directory: await mkdtemp(path.join(tmpdir(), "managed-")),
  pollMs: 60_000,
})
const read = (directory: string, name: string) => readFile(path.join(directory, name), "utf8")

describe("managed config sync", () => {
  test("writes both managed files from the gateway's copy and keeps its checksum", async () => {
    settings = { opencode: { share: "disabled" }, permissions: { allow: ["Bash"] } }
    checksum = "sha256:one"
    const options = await optionsIn()
    const state = fresh()
    await Effect.runPromise(syncOnce(state, options, "good-token"))
    const expected = render({ share: "disabled" })
    expect(await read(options.directory, "opencode.json")).toBe(expected["opencode.json"])
    expect(await read(options.directory, "opencode.jsonc")).toBe(expected["opencode.jsonc"])
    expect(state.checksum).toBe("sha256:one")
  })

  test("puts back a file someone edited, even when the gateway answers 304", async () => {
    settings = { opencode: { share: "disabled" } }
    checksum = "sha256:two"
    const options = await optionsIn()
    const state = fresh()
    await Effect.runPromise(syncOnce(state, options, "good-token"))
    await writeFile(path.join(options.directory, "opencode.jsonc"), '{ "share": "auto" }\n')
    seen.length = 0
    await Effect.runPromise(syncOnce(state, options, "good-token"))
    expect(seen[0]?.ifNoneMatch).toBe('"sha256:two"')
    expect(await read(options.directory, "opencode.jsonc")).toBe(render({ share: "disabled" })["opencode.jsonc"])
    expect(state.checksum).toBe("sha256:two")
  })

  test("follows the gateway when its copy changes", async () => {
    settings = { opencode: { share: "disabled" } }
    checksum = "sha256:three"
    const options = await optionsIn()
    const state = fresh()
    await Effect.runPromise(syncOnce(state, options, "good-token"))
    settings = { opencode: { share: "manual" } }
    checksum = "sha256:four"
    await Effect.runPromise(syncOnce(state, options, "good-token"))
    expect(await read(options.directory, "opencode.json")).toBe(render({ share: "manual" })["opencode.json"])
    expect(state.checksum).toBe("sha256:four")
  })

  test("enforces nothing when the gateway has no managed settings", async () => {
    settings = undefined
    const options = await optionsIn()
    const state = fresh()
    await Effect.runPromise(syncOnce(state, options, "good-token"))
    expect(state.checksum).toBeUndefined()
    expect(await read(options.directory, "opencode.json").catch(() => "missing")).toBe("missing")
  })

  test("sends no checksum when the files cannot be written", async () => {
    settings = { opencode: { share: "disabled" } }
    checksum = "sha256:five"
    const state = fresh()
    const options = { ...(await optionsIn()), directory: "/dev/null/opencode" }
    await Effect.runPromise(syncOnce(state, options, "good-token"))
    expect(state.checksum).toBeUndefined()
  })

  test("does nothing before sign-in", async () => {
    const options = await optionsIn()
    const state = fresh()
    seen.length = 0
    await Effect.runPromise(syncOnce(state, options, undefined))
    expect(seen).toHaveLength(0)
    expect(state.checksum).toBeUndefined()
  })
})

describe("plugin with managed config", () => {
  test("syncs at start and stamps the checksum on the provider's model requests", async () => {
    settings = { opencode: { share: "disabled" } }
    checksum = "sha256:six"
    const directory = await mkdtemp(path.join(tmpdir(), "managed-plugin-"))
    const hooks: Array<{ name: string; callback: (input: { headers: Record<string, string> }) => Effect.Effect<void>; options: unknown }> = []
    const ctx = {
      app: { name: "opencode", version: "2.4.0", channel: "latest" },
      options: {
        provider: "litellm",
        clientID: "llm_dcrc_example",
        authorizationEndpoint: "https://litellm.example/authorize",
        tokenEndpoint: "https://litellm.example/token",
        scope: "litellm",
        discoverModels: false,
        managedSettingsURL: url(),
        managedDirectory: directory,
        managedPollSeconds: 3600,
      },
      integration: {
        transform: () => Effect.succeed({ dispose: Effect.void }),
        connection: {
          active: () => Effect.succeed({ id: "c1", type: "credential" }),
          resolve: () => Effect.succeed({ type: "oauth", access: "good-token" }),
        },
      },
      session: {
        hook: (name: string, callback: (typeof hooks)[number]["callback"], options: unknown) => {
          hooks.push({ name, callback, options })
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      event: { subscribe: () => (Effect.never as unknown) },
    }
    const headers: Record<string, string> = {}
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* plugin.effect(ctx as unknown as Parameters<typeof plugin.effect>[0])
          // Let the first sync run.
          for (let i = 0; i < 50 && (yield* Effect.promise(() => read(directory, "opencode.json").catch(() => ""))) === ""; i++) {
            yield* Effect.sleep("20 millis")
          }
          yield* Effect.sleep("20 millis")
          const hook = hooks.find((h) => h.name === "model.request")
          yield* hook!.callback({ headers })
        }),
      ),
    )
    expect(hooks.find((h) => h.name === "model.request")?.options).toEqual({ providerID: "litellm" })
    expect(headers["x-org-policy"]).toBe("sha256:six")
    expect(await read(directory, "opencode.json")).toBe(render({ share: "disabled" })["opencode.json"])
  })
})
