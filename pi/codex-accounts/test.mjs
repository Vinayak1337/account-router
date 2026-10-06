// End-to-end tests: the real `pi -p` with this extension, against a local
// stand-in for the ChatGPT backend. Uses a temporary pi folder; never touches
// ~/.pi or any real account.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PI = process.env.PI_BIN || "pi";
const MODEL = "gpt-5.6-luna";

const jwt = (account, email) =>
	`h.${Buffer.from(
		JSON.stringify({
			exp: Math.floor(Date.now() / 1000) + 86400 * 30,
			"https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "pro" },
			"https://api.openai.com/profile": { email },
		}),
	).toString("base64url")}.s`;

const sse = (text) =>
	[
		{ type: "response.created", response: { id: "resp_1", status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{
			type: "response.content_part.added",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		},
		{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	]
		.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
		.join("");

// A stand-in backend: each account follows a script of replies.
async function backend(t) {
	const calls = [];
	const plans = {}; // account -> array of reply functions, last one repeats
	const usage = {}; // account -> wham/usage body
	const server = http.createServer(async (req, res) => {
		for await (const _ of req);
		const account = req.headers["chatgpt-account-id"];
		calls.push({ path: req.url.split("?")[0], account });
		if (req.url.startsWith("/wham/usage")) {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify(usage[account] ?? { rate_limit: { allowed: true, limit_reached: false } }));
		}
		const script = plans[account] || [];
		const reply = script.length > 1 ? script.shift() : script[0];
		if (!reply) {
			res.writeHead(500);
			return res.end("no plan");
		}
		reply(res);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise((r) => server.close(r)));
	return { base: `http://127.0.0.1:${server.address().port}`, calls, plans, usage };
}
const ok = (text, headers = {}) => (res) => {
	res.writeHead(200, { "content-type": "text/event-stream", ...headers });
	res.end(sse(text));
};
const limit = (resetsAt) => (res) => {
	res.writeHead(429, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { type: "usage_limit_reached", message: "limit", resets_at: resetsAt, plan_type: "pro" } }));
};
const status = (code) => (res) => {
	res.writeHead(code, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { message: `HTTP ${code}` } }));
};

async function piHome(t, accounts = ["a1", "a2"]) {
	const dir = await mkdtemp(join(tmpdir(), "pi-codex-accounts-"));
	await mkdir(join(dir, "extensions"), { recursive: true });
	await symlink(HERE, join(dir, "extensions", "codex-accounts"));
	const auth = {};
	accounts.forEach((id, i) => {
		auth[`codex-${i + 1}`] = {
			type: "oauth",
			access: jwt(id, `${id}@example.com`),
			refresh: `refresh-${id}`,
			expires: Date.now() + 86400_000 * 30,
			accountId: id,
		};
	});
	await writeFile(join(dir, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
	await writeFile(join(dir, "settings.json"), JSON.stringify({ quietStartup: true }));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
function runPi(home, base, prompt = "hi") {
	return new Promise((resolve) => {
		const child = execFile(
			PI,
			["-p", "--no-session", "--no-context-files", "--no-skills", "--provider", "codex-pool", "--model", MODEL, prompt],
			{
				env: { ...process.env, PI_CODING_AGENT_DIR: home, PI_CODEX_ACCOUNTS_BASE_URL: base, PI_OFFLINE: "1" },
				timeout: 60_000,
			},
			(error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr, out: stdout + stderr }),
		);
		// Print mode reads a piped prompt from stdin; close it.
		child.stdin.end();
	});
}
const state = async (home) => JSON.parse(await readFile(join(home, "codex-accounts.json"), "utf8"));
const responses = (calls) => calls.filter((c) => c.path === "/codex/responses").map((c) => c.account);

test("a limited account is paused until its exact reset and the request moves to the next account", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const resetsAt = Math.floor(Date.now() / 1000) + 3600;
	b.plans.a1 = [limit(resetsAt)];
	b.plans.a2 = [ok("served-by-a2")];
	const r = await runPi(home, b.base);
	assert.match(r.stdout, /served-by-a2/, r.out);
	assert.deepEqual(responses(b.calls), ["a1", "a2"]);
	const s = await state(home);
	assert.equal(s.accounts["codex-1"].blockedUntil, resetsAt * 1000);
	// The next request skips the paused account entirely.
	const again = await runPi(home, b.base);
	assert.match(again.stdout, /served-by-a2/, again.out);
	assert.deepEqual(responses(b.calls), ["a1", "a2", "a2"]);
});

test("after its reset passes, the account is confirmed with a usage check and used again first", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	b.plans.a1 = [limit(Math.floor(Date.now() / 1000) + 2), ok("a1-is-back")];
	b.plans.a2 = [ok("a2-meanwhile")];
	assert.match((await runPi(home, b.base)).stdout, /a2-meanwhile/);
	await new Promise((r) => setTimeout(r, 2500));
	b.usage.a1 = { plan_type: "pro", rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 3, reset_at: Math.floor(Date.now() / 1000) + 18000, limit_window_seconds: 18000 } } };
	const r = await runPi(home, b.base);
	assert.match(r.stdout, /a1-is-back/, r.out);
	assert.ok(b.calls.some((c) => c.path === "/wham/usage" && c.account === "a1"));
	const s = await state(home);
	assert.equal(s.accounts["codex-1"].blockedUntil, 0);
	assert.equal(s.accounts["codex-1"].windows.primary.usedPercent, 3);
});

test("a reset that leaves another window exhausted keeps the account paused until the later reset", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	b.plans.a1 = [limit(Math.floor(Date.now() / 1000) + 2)];
	b.plans.a2 = [ok("a2")];
	await runPi(home, b.base);
	await new Promise((r) => setTimeout(r, 2500));
	const weekly = Math.floor(Date.now() / 1000) + 5 * 86400;
	b.usage.a1 = {
		rate_limit: {
			allowed: false,
			limit_reached: true,
			primary_window: { used_percent: 10, reset_at: Math.floor(Date.now() / 1000) + 18000, limit_window_seconds: 18000 },
			secondary_window: { used_percent: 100, reset_at: weekly, limit_window_seconds: 604800 },
		},
	};
	assert.match((await runPi(home, b.base)).stdout, /a2/);
	const s = await state(home);
	assert.equal(s.accounts["codex-1"].blockedUntil, weekly * 1000);
	assert.deepEqual(responses(b.calls), ["a1", "a2", "a2"]);
});

test("usage headers switch accounts at the 1% cutoff before a limit error", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const reset = Math.floor(Date.now() / 1000) + 3600;
	b.plans.a1 = [
		ok("a1-last", {
			"x-codex-primary-used-percent": "99.5",
			"x-codex-primary-reset-at": String(reset),
			"x-codex-primary-window-minutes": "300",
		}),
	];
	b.plans.a2 = [ok("a2-next")];
	assert.match((await runPi(home, b.base)).stdout, /a1-last/);
	assert.match((await runPi(home, b.base)).stdout, /a2-next/);
	assert.deepEqual(responses(b.calls), ["a1", "a2"]);
});

test("brief upstream failures are retried on the same account", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	b.plans.a1 = [status(503), ok("a1-after-503")];
	const r = await runPi(home, b.base);
	assert.match(r.stdout, /a1-after-503/, r.out);
	assert.deepEqual(responses(b.calls), ["a1", "a1"]);
});

test("when every account is limited the error names the earliest reset", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	const soon = Math.floor(Date.now() / 1000) + 1800;
	b.plans.a1 = [limit(soon + 7200)];
	b.plans.a2 = [limit(soon)];
	const r = await runPi(home, b.base);
	assert.notEqual(r.code, 0);
	assert.match(r.out, /All Codex accounts are at their limit\. codex-2 \(a2@example\.com\) resets at/);
});

test("a request error that is not about the account is reported without switching", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	b.plans.a1 = [status(400)];
	b.plans.a2 = [ok("should-not-run")];
	const r = await runPi(home, b.base);
	assert.doesNotMatch(r.stdout, /should-not-run/);
	assert.deepEqual(responses(b.calls), ["a1"]);
});

test("a model missing from one account's plan is served by another account", async (t) => {
	const b = await backend(t);
	const home = await piHome(t);
	b.plans.a1 = [
		(res) => {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ detail: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." }));
		},
	];
	b.plans.a2 = [ok("sol-on-a2")];
	const r = await new Promise((resolve) => {
		const child = execFile(
			PI,
			["-p", "--no-session", "--no-context-files", "--no-skills", "--provider", "codex-pool", "--model", "gpt-6.1-sol", "hi"],
			{ env: { ...process.env, PI_CODING_AGENT_DIR: home, PI_CODEX_ACCOUNTS_BASE_URL: b.base, PI_OFFLINE: "1" } },
			(error, stdout, stderr) => resolve({ stdout, out: stdout + stderr }),
		);
		child.stdin.end();
	});
	assert.match(r.stdout, /sol-on-a2/, r.out);
	const s = await state(home);
	assert.ok(s.accounts["codex-1"].deniedModels["gpt-6.1-sol"] > Date.now());
	// The account is not paused for other models.
	assert.equal(s.accounts["codex-1"].blockedUntil, 0);
});
