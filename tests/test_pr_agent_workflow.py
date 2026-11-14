import os
import re
import subprocess
import textwrap
from pathlib import Path

import pytest


@pytest.fixture
def authorize(tmp_path):
    workflow = (Path(__file__).parents[1] / ".github/workflows/pr-agent.yml").read_text()
    block = re.search(r"^        run: \|\n((?:          .*\n|\n)+)", workflow, re.MULTILINE)
    assert block is not None
    script = textwrap.dedent(block[1]).replace("${{ github.repository }}", "beeson-group/tycho")
    script = 'gh() { printf "%s\\n" "$*" > gh-call; printf "%s\\n" "$TEST_PERMISSION"; return "$TEST_GH_STATUS"; }\n' + script

    def run(body, *, permission="write", event="issue_comment", gh_status=0):
        output = tmp_path / "output"
        output.write_text("")
        call = tmp_path / "gh-call"
        call.unlink(missing_ok=True)
        result = subprocess.run(
            ["bash", "-e", "-o", "pipefail", "-c", script],
            cwd=tmp_path,
            env={
                **os.environ,
                "COMMENT_BODY": body,
                "SENDER": "test-user",
                "GITHUB_EVENT_NAME": event,
                "GITHUB_OUTPUT": str(output),
                "TEST_PERMISSION": permission,
                "TEST_GH_STATUS": str(gh_status),
            },
            capture_output=True,
            check=False,
            text=True,
            timeout=10,
        )
        if gh_status == 0:
            assert result.returncode == 0, result.stderr
        return output.read_text(), call.read_text() if call.exists() else ""

    return run


@pytest.mark.parametrize("body", ["/does-not-exist", "/reviewoops", "/help_docs", "/extend", "/", "/review#oops", '/review "unclosed'])
def test_unknown_commands_do_not_enter_review_concurrency(authorize, body):
    output, call = authorize(body)
    assert output == "authorized=false\n"
    assert call == ""


@pytest.mark.parametrize(
    "command",
    [
        "auto_review",
        "answer",
        "review",
        "review_pr",
        "describe",
        "describe_pr",
        "improve",
        "improve_code",
        "ask",
        "ask_question",
        "ask_line",
        "update_changelog",
        "config",
        "settings",
        "help",
        "similar_issue",
        "add_docs",
        "generate_labels",
    ],
)
def test_supported_commands_and_aliases_are_authorized(authorize, command):
    output, call = authorize("/" + command)
    assert output == "authorized=true\n"
    assert call == "api repos/beeson-group/tycho/collaborators/test-user/permission --jq .permission\n"


@pytest.mark.parametrize(
    "body",
    [' \n\t/REVIEW --pr_reviewer.extra_instructions="check it"', "/ask What's #123?", '/"review"', "//review", '/ask "$(touch injected)"'],
)
def test_command_parsing_preserves_whitespace_case_quotes_and_arguments(authorize, tmp_path, body):
    assert authorize(body)[0] == "authorized=true\n"
    assert not (tmp_path / "injected").exists()


@pytest.mark.parametrize("body", ["", " \n\t", "Looks good", "review", "Please /review"])
def test_ordinary_comments_are_rejected_before_permission_lookup(authorize, body):
    assert authorize(body) == ("authorized=false\n", "")


@pytest.mark.parametrize("permission", ["none", "read", "triage", "write", "maintain", "admin"])
@pytest.mark.parametrize("event", ["issue_comment", "pull_request"])
def test_effective_write_permission_is_required(authorize, permission, event):
    expected = "true" if permission in {"write", "maintain", "admin"} else "false"
    assert authorize("/review" if event == "issue_comment" else "", permission=permission, event=event)[0] == f"authorized={expected}\n"


def test_permission_lookup_failure_cannot_authorize(authorize):
    assert "authorized=true" not in authorize("/review", permission="", gh_status=1)[0]
