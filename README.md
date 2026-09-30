# pi-ssh

Work on a remote machine from [pi](https://github.com/earendil-works/pi), with every tool.

```bash
pi --ssh user@host
pi --ssh deploy@build-box:/srv/app
pi --ssh "user@[2001:db8::1]:2222:/srv/app"
```

With the flag set, `read`, `write`, `edit`, `bash`, `ls`, `grep` and `find` all execute
on the remote host. The local working directory is **mapped** onto the remote one, so
the model keeps using the paths it already knows: opening `src/index.ts` reads
`<remote-cwd>/src/index.ts` over SSH, and search results are translated back into the
same local path space. Without the flag everything behaves exactly like stock pi, and
`/ssh on user@host` can connect mid-session.

## Install

```bash
ln -s ~/pi-ssh ~/.pi/agent/extensions/pi-ssh
```

Requires the `ssh` client and key-based auth (the transport uses `BatchMode=yes`, so
password prompts never block the agent). The remote login shell should be POSIX
(bash/zsh/dash).

## What the model gets

- **All tools, remotely** — file tools go through remote `cat`/`mkdir` with
  POSIX-correct quoting (hostile paths like `we ird; $(touch pwned) 'dir'` are safe);
  big writes travel over stdin, not the command line.
- **Remote search** — `grep` uses ripgrep when the host has it (gitignore-aware) and
  falls back to plain `grep`; `find` uses `fd`, else `find`; `ls` lists the remote
  directory. Results are rewritten into local paths, ready to hand to another tool.
- **`!command` runs remotely too** — the `user_bash` hook routes the user's own shell
  escapes to the host.
- **Honest system prompt** — a section tells the model where it actually is, what the
  mapping covers, and whether a local escape exists.
- **`--ssh-allow-local`** — lets the bash tool run on this machine when a command is
  prefixed with `local: ` (off by default; there is no silent bridge between the two).

## Controlling the link

```
/ssh                  status: host, remote tools, mapping, escape hatch
/ssh run <cmd>        run one command remotely and show the output
/ssh local <cmd>      run one command locally, for comparison
/ssh on <target>      connect mid-session (same syntax as the flag)
/ssh off              disconnect; tools run locally again
```

Flag values: `user@host`, `user@host:/abs/dir`, `user@host:~/rel`, `user@host:2222`,
`user@[v6]:port:/dir`. Extra `ssh` options (ports, identities, jump hosts) come from
the environment:

```bash
PI_SSH_OPTIONS='-i ~/.ssh/id_ed25519 -J bastion' pi --ssh user@host
```

## How it works

- **One multiplexed connection.** `ControlMaster=auto` turns the first call into the
  master and every later call into a nearly free slave, so a typical agent turn with
  dozens of small tool calls doesn't pay a TCP + auth handshake each time.
- **Capability probe at connect.** One round trip resolves the remote cwd, kernel and
  which of `rg`/`fd`/`file` exist, so search picks the best tool per host.
- **Aborts kill the real work.** Each remote command publishes its shell pid; on
  abort or timeout pi-ssh signals the remote process group (`kill -- -pid`), kills the
  local ssh client and destroys its pipes so nothing waits on the multiplexer. A
  stopped 30-minute build stops on the remote host too, and immediately.

## Development

```bash
bun install
bun run typecheck
bun test                              # offline suite (fake ssh, no network)
bun run test:remote                   # real suite against localhost
PI_SSH_TEST_HOST=user@host bun run test:remote
```

The offline suite runs the whole transport against `test/fake-ssh.sh`, which executes
the "remote" command locally in a fresh session — real quoting, stdin and kill paths,
no sshd needed. The remote suite additionally exercises a real SSH server.

## License

MIT
