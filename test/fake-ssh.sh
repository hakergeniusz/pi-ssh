#!/bin/sh
# A stand-in for `ssh(1)` used by the offline integration tests.
#
# It parses the argument vector pi-ssh builds and runs the final remote command
# string with `sh -c`. Because the "remote" paths in the tests are real local
# directories, this exercises the real quoting, `cd` handling and stdin
# plumbing of pi-ssh with no sshd, no keys and no network.
#
# Environment:
#   FAKE_SSH_TARGET  destination that is accepted (default: localhost);
#                    anything else fails with ssh's own exit code 255
#   FAKE_SSH_LOG     optional file that receives one line per invocation
set -eu

target=""
while [ $# -gt 0 ]; do
	case "$1" in
		-O) shift; [ $# -gt 0 ] && shift; continue ;;
		-o|-p|-i|-l|-F|-c|-E|-I|-m|-Q|-S|-w) shift; [ $# -gt 0 ] && shift; continue ;;
		--) shift; break ;;
		-*) shift; continue ;;
		*)
			target="$1"
			shift
			break
			;;
	esac
done
command="$*"

accepted="${FAKE_SSH_TARGET:-localhost}"
case "$target" in
	"$accepted"|*@"$accepted") ;;
	*)
		echo "fake-ssh: ssh: Could not resolve hostname $target: Name or service not known" >&2
		exit 255
		;;
esac

if [ -n "${FAKE_SSH_LOG:-}" ]; then
	printf '%s\n' "$command" >>"$FAKE_SSH_LOG"
fi

# sshd runs each command session in its own process group (setsid); mirror that
# so aborts can signal the command's group exactly like they do remotely.
if command -v setsid >/dev/null 2>&1; then
	exec setsid sh -c "$command"
fi
exec sh -c "$command"
