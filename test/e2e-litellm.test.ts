// End to end against a running LiteLLM with the POC config (see poc/litellm):
//   LITELLM_URL=http://127.0.0.1:4000 LITELLM_KEY=sk-poc-master bun test test/e2e-litellm.test.ts
// The key stands in for the OAuth access token the plugin would hold after sign-in.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import plugin from "../src/index.js"

const base = process.env.LITELLM_URL
const key = process.env.LITELLM_KEY ?? ""
const run = base ? describe : describe.skip

const read = (directory: string, name: string) => readFile(path.join(directory, name), "utf8").catch(() => "")
const chat = (headers: Record<string, string>) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model: "poc-model", messages: [{ role: "user", content: "hi" }] }),
  })

run("plugin against LiteLLM", () => {
  test("writes the managed config, repairs it, and its requests pass the gateway's check", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "managed-e2e-"))
    let modelRequest: ((input: { headers: Record<string, string> }) => Effect.Effect<void>) | undefined
    const ctx = {
      options: {
        provider: "litellm",
        clientID: "llm_dcrc_example",
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
        scope: "litellm",
        discoverModels: false,
        managedSettingsURL: `${base}/claude_code_gateway/managed/settings`,
        managedDirectory: directory,
        managedPollSeconds: 3600,
      },
      integration: {
        transform: () => Effect.succeed({ dispose: Effect.void }),
        connection: {
          active: () => Effect.succeed({ id: "c1", type: "credential" }),
          resolve: () => Effect.succeed({ type: "oauth", access: key }),
        },
      },
      session: {
        hook: (name: string, callback: typeof modelRequest) => {
          if (name === "model.request") modelRequest = callback
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      event: { subscribe: () => Effect.never },
    }

    const waitFor = (check: () => Promise<boolean>) =>
      Effect.promise(async () => {
        for (let i = 0; i < 100; i++) {
          if (await check()) return true
          await Bun.sleep(50)
        }
        return false
      })

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* plugin.effect(ctx as unknown as Parameters<typeof plugin.effect>[0])
          const written = yield* waitFor(async () => (await read(directory, "opencode.jsonc")).includes('"share"'))
          yield* Effect.sleep("50 millis")

          const headers: Record<string, string> = {}
          yield* modelRequest!({ headers })
          const withHeader = yield* Effect.promise(() => chat(headers))
          const withoutHeader = yield* Effect.promise(() => chat({}))

          // Someone loosens the managed config by hand; the plugin puts it back.
          const good = yield* Effect.promise(() => read(directory, "opencode.jsonc"))
          yield* Effect.promise(() => writeFile(path.join(directory, "opencode.jsonc"), '{ "share": "auto" }\n'))
          const repaired = yield* waitFor(async () => (await read(directory, "opencode.jsonc")) === good)

          return {
            written,
            header: headers["x-org-policy"],
            withHeader: withHeader.status,
            withoutHeader: withoutHeader.status,
            repaired,
            config: JSON.parse(yield* Effect.promise(() => read(directory, "opencode.json"))),
          }
        }),
      ),
    )

    console.log(JSON.stringify(result, null, 2))
    expect(result.written).toBe(true)
    expect(result.header).toStartWith("sha256:")
    expect(result.withHeader).toBe(200)
    expect(result.withoutHeader).toBe(403)
    expect(result.repaired).toBe(true)
    expect(result.config.share).toBe("disabled")
  }, 30_000)
})
