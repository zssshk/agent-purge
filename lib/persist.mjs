// 持久化层：把 persona 写进 harness 自己的配置，这样用户在自己终端敲 codex 也生效。
// 分两类：托管块（文本文件，带标记，可精确删除）与插件文件（可删）。
// 不动二进制——这里只做可逆的配置改动。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BEGIN = "# >>> agent-purge";
const END = "# <<< agent-purge";
const home = process.env.USERPROFILE || process.env.HOME;
// Hermes 默认家目录是分平台的：Windows 用 AppData/Local/hermes，
// Linux/macOS 用 ~/.hermes。旧代码在所有平台上都写 AppData，
// 在 Linux/macOS 上会凭空建一个网关不读的目录，还误报已安装。
const hermesHome = () =>
	process.env.HERMES_HOME ||
	(process.platform === "win32" ? join(home, "AppData", "Local", "hermes") : join(home, ".hermes"));

export const targets = {
	pi: {
		// pi 每次启动都读全局 AGENTS.md（“Global Agent Rules”），它就是 pi 唯一的 sys 层常驻口
		// 代价：正文是快照，换 persona 要重新 install
		file: () => join(home, ".pi", "agent", "AGENTS.md"),
		kind: "block",
		layer: "sys",
		note: "全局 AGENTS.md，每次启动重读；正文是快照，换人设要重装",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	claude: {
		// 用户级 CLAUDE.md：每次都读，但进入的是 <system-reminder> 的上下文块（USER 层），不是 system 数组
		file: () => join(home, ".claude", "CLAUDE.md"),
		kind: "block",
		layer: "user",
		note: "CLAUDE.md 进的是 <system-reminder> 上下文块（用户消息），不是 system 数组",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	grok: {
		// grok 把全局 AGENTS.md 的内容 append 到系统提示；单文件上限 10000 字符，超了会被截
		file: () => join(home, ".grok", "AGENTS.md"),
		kind: "block",
		layer: "sys",
		note: "内容 append 进系统提示；单文件上限 10000 字符，超了会自动截断",
		body: (active) => clamp(readFileSync(active, "utf8").trim(), 9600),
	},
	zcode: {
		// 官方文档：~/.zcode/AGENTS.md 是“every workspace 的默认 instructions”（桌面闭源，无法抓包复核）
		file: () => join(home, ".zcode", "AGENTS.md"),
		kind: "block",
		layer: "sys",
		note: "官方文档写的默认 instructions 文件；桌面版闭源，无法抓包复核",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	omp: {
		// Oh My Pi 血统：~/.omp/agent/AGENTS.md 就是它的 rules 文件（--no-rules 关的就是它）
		file: () => join(home, ".omp", "agent", "AGENTS.md"),
		kind: "block",
		layer: "sys",
		note: "就是它的 rules 文件（--no-rules 关的就是这个）",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	hermes: {
		// SOUL.md 每次构建提示都重读（prompt_builder.load_soul_md）
		file: () => join(hermesHome(), "SOUL.md"),
		kind: "block",
		layer: "sys",
		note: "SOUL.md 每次构建提示都重读（prompt_builder.load_soul_md）",
		body: (active) => readFileSync(active, "utf8").trim(),
	},
	codex: {
		file: () => join(home, ".codex", "config.toml"),
		kind: "block",
		layer: "sys",
		note: "model_instructions_file 直接换掉它的指令文件（连 GUI/子进程启动都生效）",
		body: (active) => `model_instructions_file = "${active.replace(/\\/g, "/")}"`,
	},
	opencode: {
		// 写入用全局单一位置；读取/删除要扫全部历史位置，否则老版本留下的项目级插件会继续注入
		file: () => join(home, ".config", "opencode", "plugins", "agent-purge.ts"),
		files: () => [
			join(home, ".config", "opencode", "plugins", "agent-purge.ts"),
			join(home, ".config", "opencode", "plugin", "agent-purge.ts"),
			join(process.cwd(), ".opencode", "plugin", "agent-purge.ts"),
		],
		kind: "file",
		layer: "sys",
		note: "插件改 chat.system（SYS 层真改）；每轮读 state.json + active.md，人设与模式（off/replace/append）全部热切",
		// 每轮请求都重拼一次 system：人设、模式都从 state.json 现读 → 真热切，不用重启
		body: (active, root) => `import { readFileSync } from "node:fs";
// agent-purge 托管文件：删除即可取消
const PERSONA = ${JSON.stringify(active.replace(/\\/g, "/"))};
const STATE = ${JSON.stringify(join(root, "state.json").replace(/\\/g, "/"))};
function cfg() {
  try {
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    const mode = st && st.default ? st.default.mode : "replace";
    const body = readFileSync(PERSONA, "utf8").trim();
    return body ? { mode: mode || "replace", body } : null;
  } catch {
    return null;
  }
}
export const AgentPurge = async () => ({
  "experimental.chat.system.transform": async (_input, output) => {
    const c = cfg();
    if (!c || c.mode === "off") return;
    if (c.mode === "append") output.system.push(c.body);
    else output.system.splice(0, output.system.length, c.body);
  },
});
`,
	},
};

export function status(_root) {
	return Object.entries(targets).map(([name, t]) => {
		const file = t.file();
		const candidates = t.files ? t.files() : [file];
		const present = candidates.filter((f) => existsSync(f));
		if (!present.length) return { name, installed: false, file };
		// 文件类目标：只要还存在任意一份托管文件就算“已安装”（内容可能是旧版本写的）
		const installed =
			t.kind === "block"
				? present.some((f) => readFileSync(f, "utf8").includes(BEGIN))
				: present.length > 0;
		return { name, installed, file: present[0], files: present };
	});
}

export function install(name, { root, active }) {
	const t = targets[name];
	if (!t) return { error: `${name} 没有持久化后端（见 notes：grok/omp 只有 CLI 开关，claude/zcode/antigravity 要打补丁）` };
	const file = t.file();
	mkdirSync(dirname(file), { recursive: true });
	if (t.kind === "file") {
		writeFileSync(file, t.body(active, root));
		return { file, action: "wrote-whole-file" };
	}
	const old = existsSync(file) ? readFileSync(file, "utf8") : "";
	const next = upsertBlock(old, t.body(active));
	writeFileSync(file, next);
	return { file, action: old.includes(BEGIN) ? "replaced-block" : "appended-block" };
}

export function uninstall(name) {
	const t = targets[name];
	if (!t) return { error: `${name} 没有持久化后端` };
	if (t.kind === "file") {
		// 清掉所有历史位置，保证“关掉”之后没有任何残留插件还在注入
		const candidates = t.files ? t.files() : [t.file()];
		const gone = candidates.filter((f) => existsSync(f));
		if (!gone.length) return { file: t.file(), action: "already-gone" };
		for (const f of gone) rmSync(f, { force: true });
		return { file: gone[0], files: gone, action: "deleted-file" };
	}
	const file = t.file();
	if (!existsSync(file)) return { file, action: "already-gone" };
	const old = readFileSync(file, "utf8");
	if (!old.includes(BEGIN)) return { file, action: "no-block" };
	const stripped = stripBlock(old);
	// 只剩空白说明这文件本来就是给我们用的，直接删掉别留空壳
	if (!stripped.trim()) {
		rmSync(file, { force: true });
		return { file, action: "deleted-empty-file" };
	}
	writeFileSync(file, stripped);
	return { file, action: "removed-block" };
}

// 按标记替换或追加，幂等
function upsertBlock(text, body) {
	const block = `${BEGIN}\n${body}\n${END}`;
	if (text.includes(BEGIN)) return text.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`), block);
	return `${text.replace(/\s*$/, "")}\n\n${block}\n`;
}

function stripBlock(text) {
	return text.replace(/\n*# >>> agent-purge[\s\S]*?# <<< agent-purge\n*/, "\n").replace(/\s*$/, "\n");
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 有些 harness 对单文件有硬上限（grok：10000 字符），超了直接截断并留一行明说 */
function clamp(text, max) {
	if (text.length <= max) return text;
	return text.slice(0, max) + "\n\n（agent-purge：超出该 harness 的文件上限，此处被截断）";
}
