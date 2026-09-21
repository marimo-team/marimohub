import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';
import { KERNEL_BOOTSTRAP_CLIENT } from './client';

const run = promisify(execFile);
async function python(assertions: string) {
	await run('python3', ['-c', `__name__ = "test"\n${KERNEL_BOOTSTRAP_CLIENT}\n${assertions}`]);
}

describe('sandbox bootstrap protocol', () => {
	it('normalizes session maps, arrays, and envelopes without accepting missing identifiers', async () => {
		await python(String.raw`
from unittest.mock import Mock
client = object.__new__(MarimoClient)
sessions = [{"id": "first", "filename": "notebook.py"}, {"session_id": "second"}]
expected = {"first": sessions[0], "second": sessions[1]}
for response in (expected, sessions, {"sessions": sessions}):
    client.request = Mock(return_value=json.dumps(response))
    assert client.sessions() == expected
    client.request.assert_called_once_with("/api/sessions")
for response in ({}, [], {"sessions": []}):
    client.request = Mock(return_value=json.dumps(response))
    assert client.sessions() == {}
for response in (None, "invalid", [None], [{}], [{"id": ""}], [{"id": 1}],
                 {"first": None}, {"": {}}, {"sessions": [{}]}):
    client.request = Mock(return_value=json.dumps(response))
    try:
        client.sessions()
        raise AssertionError("accepted malformed sessions")
    except Incompatible:
        pass
`);
	});
	it('reads escaped editor settings and rejects missing or malformed settings', async () => {
		await python(String.raw`
from html import escape
for auto_run in (True, False):
    config = escape(json.dumps({"runtime": {"auto_instantiate": auto_run}}), quote=True)
    html = '<marimo-server-token data-token="a&amp;b"></marimo-server-token><marimo-user-config data-config="' + config + '"></marimo-user-config>'
    assert EditorData.read(html) == ("a&b", auto_run)
for config in (None, [], {}, {"runtime": None}, {"runtime": {"auto_instantiate": 1}}, {"runtime": {"auto_instantiate": "true"}}):
    html = '<marimo-server-token data-token="test"></marimo-server-token><marimo-user-config data-config="' + escape(json.dumps(config), quote=True) + '"></marimo-user-config>'
    try:
        EditorData.read(html)
        raise AssertionError("accepted malformed settings")
    except Incompatible:
        pass
for html in ("", '<marimo-server-token data-token=""></marimo-server-token>', '<marimo-user-config data-config="{broken"></marimo-user-config>'):
    try:
        EditorData.read(html)
        raise AssertionError("accepted incomplete editor data")
    except Incompatible:
        pass
`);
	});
	it('inspects live browser sessions without initializing or connecting to them', async () => {
		await python(String.raw`
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch
with TemporaryDirectory() as directory:
    cfg = {"token_file": directory + "/token", "inspect": True}
    for sessions, states, expected in (({}, [], "initializing"), ({"browser": {}}, [False], "initializing"),
                                      ({"browser": {}}, [True], "ready"),
                                      ({"stopped": {}, "browser": {}}, [False, True], "ready")):
        client = Mock()
        client.sessions.return_value = sessions
        client.is_live.side_effect = states
        with patch.dict(globals(), {"MarimoClient": lambda *_: client}):
            assert bootstrap(cfg, lambda: 1) == expected
        client.configure.assert_not_called()
        client.session.assert_not_called()
        client.initialize.assert_not_called()
        assert Path(cfg["token_file"] + ".bootstrap.lock").read_text() == ""
`);
	});
	it('does not wait for a busy bootstrap lock during read-only inspection', async () => {
		await python(String.raw`
from tempfile import TemporaryDirectory
with TemporaryDirectory() as directory:
    token_file = directory + "/token"
    with bootstrap_lock(token_file, False, lambda: 1):
        try:
            with bootstrap_lock(token_file, True, lambda: 1):
                raise AssertionError("acquired an occupied lock")
        except TimeoutError:
            pass
    with bootstrap_lock(token_file, True, lambda: 1):
        pass
`);
	});
	it('sanitizes protocol failures and always clears the process deadline', async () => {
		await python(String.raw`
from unittest.mock import patch
cases = [(ImportError("secret"), "awaiting_client"), (Incompatible(), "awaiting_client"),
         (TimeoutError(), "initializing"), (ValueError("secret"), "unavailable"),
         (HTTPError("secret", 401, "secret", {}, None), "unavailable"),
         (HTTPError("secret", 500, "secret", {}, None), "unavailable"),
         (HTTPError("secret", 404, "secret", {}, None), "awaiting_client")]
for error, expected in cases:
    with patch.dict(globals(), {"bootstrap": lambda *args: (_ for _ in ()).throw(error)}):
        assert run_client({"seconds": 1}) == expected
        assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)
`);
	});
	it('bounds persistent connection failures and allows transient startup recovery', async () => {
		await python(String.raw`
from unittest.mock import Mock, patch
for error in (URLError(ConnectionRefusedError()), ConnectionRefusedError(), ConnectionResetError()):
    for inspect in (False, True):
        probe = Mock(side_effect=error)
        sleep = Mock()
        with patch.dict(globals(), {"bootstrap": probe}), patch.object(time, "sleep", sleep):
            assert run_client({"seconds": 60, "inspect": inspect}) == "unavailable"
        assert probe.call_count == (1 if inspect else 3)
        assert sleep.call_count == (0 if inspect else 2)
        assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)
for failures in (1, 2):
    probe = Mock(side_effect=[URLError(ConnectionRefusedError())] * failures + ["ready"])
    sleep = Mock()
    with patch.dict(globals(), {"bootstrap": probe}), patch.object(time, "sleep", sleep):
        assert run_client({"seconds": 1.8, "inspect": False}) == "ready"
    assert probe.call_count == failures + 1
    assert [call.args for call in sleep.call_args_list] == [(0.1,)] * failures
    assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)
`);
	});
	it('retains the probe deadline across connection retries', async () => {
		await python(String.raw`
from unittest.mock import Mock, patch
probe = Mock(side_effect=URLError(ConnectionRefusedError()))
with patch.dict(globals(), {"bootstrap": probe}), patch.object(time, "monotonic", side_effect=[0, 0, 1]):
    assert run_client({"seconds": 1, "inspect": False}) == "initializing"
assert probe.call_count == 1
assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)
`);
	});
	it('rejects failed initialization responses and stopped kernels', async () => {
		await python(String.raw`
from unittest.mock import Mock
client = object.__new__(MarimoClient)
client.auto_run = False
for response in ('null', '[]', '{}', '{"success":false}', '{"success":1}'):
    client.request = Mock(return_value=response)
    try:
        client.initialize("live")
        raise AssertionError("accepted failed initialization")
    except RuntimeError:
        pass
client.request = Mock(side_effect=['{"success":true}', '{"state":"stopped"}'])
try:
    client.initialize("live")
    raise AssertionError("accepted a stopped kernel")
except RuntimeError:
    pass
for auto_run in (True, False):
    client.auto_run = auto_run
    client.request = Mock(side_effect=['{"success":true}', '{"state":"running"}'])
    client.initialize("live")
    assert client.request.call_args_list[0].args == (
        "/api/kernel/instantiate", {"objectIds": [], "values": [], "autoRun": auto_run}, "live")
    assert client.request.call_args_list[0].args[1]["autoRun"] is auto_run
`);
	});
});
