import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

// scripts/backup.sh (the backup host's half) against a fake app host: a stub
// `ssh` that runs the command locally, a stub `age`, and a fake
// backup-remote.sh whose hashes the test sets. No Docker, network, or database.

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const backupSh = path.join(root, "scripts/backup.sh");
const base = mkdtempSync(path.join(tmpdir(), "backup-test-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const bash = (script: string, env: Record<string, string> = {}) =>
  run("bash", ["-c", script], { env: { ...process.env, ...env } });

// Calls a function from backup.sh without running main.
const call = (fn: string) => bash(`source "${backupSh}"; ${fn}`);

const archiveName = (server: string, stamp: string) =>
  `hol-${server}-${stamp}.tar.age`;

describe("prune_archives", () => {
  it("keeps the newest 5 of one server and touches nothing else", async () => {
    const dir = mkdtempSync(path.join(base, "prune-"));
    const stamps = Array.from(
      { length: 8 },
      (_, i) => `2026010${i + 1}T000000Z`,
    );
    stamps.forEach((s) =>
      writeFileSync(path.join(dir, archiveName("prod", s)), "x"),
    );
    // A server whose name starts with "prod-", a state file, and a stray file.
    writeFileSync(
      path.join(dir, archiveName("prod-2", "20260101T000000Z")),
      "x",
    );
    writeFileSync(path.join(dir, ".state"), "x");
    writeFileSync(path.join(dir, "notes.txt"), "x");

    await call(`prune_archives "${dir}" prod 5`);

    const left = readdirSync(dir).sort();
    expect(left.filter((f) => f.startsWith("hol-prod-2-"))).toHaveLength(1);
    const prod = left.filter((f) => /^hol-prod-\d{8}T/.test(f));
    expect(prod).toEqual(stamps.slice(3).map((s) => archiveName("prod", s)));
    expect(left).toContain(".state");
    expect(left).toContain("notes.txt");
  });

  it("refuses a relative directory", async () => {
    await expect(
      call(`prune_archives "relative/dir" prod 5`),
    ).rejects.toThrow();
  });
});

describe("decide_stage1 and decide_stage2", () => {
  const stage1 = async (args: string) =>
    (await call(`decide_stage1 ${args}`)).stdout.trim();

  it("skips when nothing moved and the safety net is not due", async () => {
    expect(await stage1("0 s1 d1 s1 d1 60 604800")).toBe("skip unchanged");
  });
  it("forces, first run, and the weekly safety net", async () => {
    expect(await stage1("1 s1 d1 s1 d1 60 604800")).toBe("backup forced");
    expect(await stage1("0 s1 d1 '' '' 60 604800")).toBe("backup first run");
    expect(await stage1("0 s1 d1 s1 d1 604800 604800")).toBe(
      "backup weekly safety net",
    );
  });
  it("asks for the content hash when secrets or write counters moved", async () => {
    expect(await stage1("0 s2 d1 s1 d1 60 604800")).toBe(
      "check secret files changed",
    );
    expect(await stage1("0 s1 d2 s1 d1 60 604800")).toBe(
      "check database changed",
    );
  });
  it("backs up only when secrets or content differ", async () => {
    const stage2 = async (a: string) =>
      (await call(`decide_stage2 ${a}`)).stdout.trim();
    expect(await stage2("s1 c1 s1 c1")).toBe("skip");
    expect(await stage2("s2 c1 s1 c1")).toBe("backup");
    expect(await stage2("s1 c2 s1 c1")).toBe("backup");
  });
});

describe("parse_config", () => {
  const parse = async (text: string) => {
    const file = path.join(mkdtempSync(path.join(base, "conf-")), "c.conf");
    writeFileSync(file, text);
    return call(
      `parse_config "${file}" && echo "$(printf '%s,' "\${servers[@]}")" && setting b keep && echo && setting a keep`,
    );
  };

  it("reads sections, defaults and comments", async () => {
    const { stdout } = await parse(
      "keep = 5\n# a comment\n[a]\nssh_host = x # trailing\n[b]\nkeep = 2\n",
    );
    expect(stdout.split("\n")[0]).toBe("a,b,");
    expect(stdout).toContain("2\n5");
  });
  it("rejects a line it cannot read", async () => {
    await expect(parse("[a]\nthis is wrong\n")).rejects.toThrow();
  });
});

// ---- the whole flow, with the fake app host ---------------------------------
type Fake = {
  readonly dir: string;
  readonly dest: string;
  readonly conf: string;
  readonly set: (name: "secrets" | "stats" | "content", v: string) => void;
  readonly backup: (...args: string[]) => Promise<string>;
  readonly archives: () => string[];
};

const makeFake = (keep = 5): Fake => {
  const dir = mkdtempSync(path.join(base, "fake-"));
  const repo = path.join(dir, "repo");
  const dest = path.join(dir, "dest");
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "payload/secrets"), { recursive: true });
  writeFileSync(path.join(dir, "payload/db.dump"), "dump");
  writeFileSync(path.join(dir, "payload/secrets/auth_secret"), "s3cret");
  writeFileSync(path.join(dir, "payload/docker.env"), "APP_HOST=x\n");

  // A manifest that matches the payload, written the way backup-remote.sh does.
  writeFileSync(
    path.join(repo, "scripts/backup-remote.sh"),
    `#!/usr/bin/env bash
sub="\${1##* }"
case "$sub" in
  fingerprint) echo "secrets=$(cat "${dir}/secrets")"; echo "stats=$(cat "${dir}/stats")" ;;
  contenthash) echo "content=$(cat "${dir}/content")" ;;
  archive)
    cp -r "${dir}/payload" "${dir}/stage"
    { echo "format=1"; echo "files:"; (cd "${dir}/stage" && find . -type f ! -name MANIFEST | sort | xargs sha256sum); } > "${dir}/stage/MANIFEST"
    [ -f "${dir}/corrupt" ] && echo tampered > "${dir}/stage/db.dump"
    tar -cf - -C "${dir}/stage" .
    rm -rf "${dir}/stage" ;;
esac
`,
  );
  chmodSync(path.join(repo, "scripts/backup-remote.sh"), 0o755);

  const ssh = path.join(dir, "fakessh");
  writeFileSync(ssh, `#!/usr/bin/env bash\nexec bash -c "\${@: -1}"\n`);
  chmodSync(ssh, 0o755);
  const age = path.join(dir, "fakeage");
  writeFileSync(
    age,
    `#!/usr/bin/env bash\nwhile [ $# -gt 1 ]; do case "$1" in -o) out="$2"; shift 2;; -r) shift 2;; *) break;; esac; done\ncat "$1" > "$out"\n`,
  );
  chmodSync(age, 0o755);

  const conf = path.join(dir, "backup.conf");
  writeFileSync(
    conf,
    `keep = ${keep}
[one]
ssh_host = u@h
ssh_key = ${dir}/key
repo_dir = ${repo}
dest_dir = ${dest}
age_recipient = age1abcdefgh
`,
  );

  const set: Fake["set"] = (name, v) => writeFileSync(path.join(dir, name), v);
  set("secrets", "s1");
  set("stats", "d1");
  set("content", "c1");

  const env = { BACKUP_SSH_BIN: ssh, AGE_BIN: age };
  const backup: Fake["backup"] = async (...args) => {
    try {
      const { stdout } = await run(backupSh, ["--config", conf, ...args], {
        env: { ...process.env, ...env },
      });
      return stdout;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(`${err.stdout ?? ""}${err.stderr ?? ""}`);
    }
  };
  const archives = () =>
    existsSync(dest)
      ? readdirSync(dest).filter((f) => f.endsWith(".tar.age"))
      : [];
  return { dir, dest, conf, set, backup, archives };
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("backup.sh end to end", () => {
  it("backs up once, then skips while nothing changes", async () => {
    const f = makeFake();
    expect(await f.backup()).toContain("saved");
    expect(f.archives()).toHaveLength(1);
    expect(await f.backup()).toContain("unchanged");
    expect(f.archives()).toHaveLength(1);
  });

  it("backs up again when a secret changes or the content changes", async () => {
    const f = makeFake();
    await f.backup();
    await pause(1100);
    f.set("secrets", "s2");
    expect(await f.backup()).toContain("saved");
    await pause(1100);
    f.set("stats", "d2");
    f.set("content", "c2");
    expect(await f.backup()).toContain("saved");
    expect(f.archives()).toHaveLength(3);
  });

  it("does not back up when only a noisy table moved (content hash same)", async () => {
    const f = makeFake();
    await f.backup();
    f.set("stats", "d2");
    expect(await f.backup()).toContain("only noise changed");
    expect(f.archives()).toHaveLength(1);
    // The new counters are remembered, so the next run is a plain skip.
    expect(await f.backup()).toContain("unchanged");
  });

  it("--force always backs up, --dry-run saves nothing, keep=2 prunes", async () => {
    const f = makeFake(2);
    expect(await f.backup("--dry-run")).toContain("would back up");
    expect(f.archives()).toHaveLength(0);
    for (let i = 0; i < 3; i += 1) {
      await f.backup("--force");
      await pause(1100);
    }
    expect(f.archives()).toHaveLength(2);
  });

  it("saves nothing when the archive fails its manifest check", async () => {
    const f = makeFake();
    writeFileSync(path.join(f.dir, "corrupt"), "1");
    await expect(f.backup()).rejects.toThrow(/failed its check/);
    expect(f.archives()).toHaveLength(0);
  });

  it("one server failing does not stop the next", async () => {
    const f = makeFake();
    writeFileSync(
      f.conf,
      `[bad]
ssh_host = u@h
ssh_key = k
repo_dir = /nonexistent
dest_dir = ${f.dest}-bad
age_recipient = notakey
[one]
ssh_host = u@h
ssh_key = ${f.dir}/key
repo_dir = ${path.join(f.dir, "repo")}
dest_dir = ${f.dest}
age_recipient = age1abcdefgh
`,
    );
    await expect(f.backup()).rejects.toThrow(/1 server\(s\) failed/);
    expect(f.archives()).toHaveLength(1);
  });
});

describe("the real ssh call", () => {
  it("is key only, batch mode, with the host key checked", async () => {
    const f = makeFake();
    const argv = path.join(f.dir, "argv");
    const ssh = path.join(f.dir, "recordssh");
    writeFileSync(
      ssh,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argv}"\nexit 1\n`,
    );
    chmodSync(ssh, 0o755);
    await run(backupSh, ["--config", f.conf], {
      env: { ...process.env, BACKUP_SSH_BIN: ssh },
    }).catch(() => undefined);
    const args = (await run("cat", [argv])).stdout;
    for (const needed of [
      "BatchMode=yes",
      "PasswordAuthentication=no",
      "KbdInteractiveAuthentication=no",
      "StrictHostKeyChecking=yes",
      "IdentitiesOnly=yes",
    ]) {
      expect(args).toContain(needed);
    }
  });
});

describe("tracked files", () => {
  it("commits the example config but never a real one", async () => {
    const { stdout } = await run("git", ["ls-files", "backup"], { cwd: root });
    expect(stdout.trim().split("\n")).toEqual(["backup/backup.conf.example"]);
  });
});
