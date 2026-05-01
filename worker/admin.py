"""One-off admin / ops scripts for sing-anything.

These don't run as part of the user-facing pipeline — they're recovery
and maintenance tools you invoke via `modal run` when you need to
intervene by hand (purge a user's data, audit something, etc.). Living
in their own module keeps them out of the hot pipeline image and out
of the way of the API endpoints.

Slim image (no ffmpeg, no GPU, no demucs/whisperx/crepe) — these
scripts only need supabase + httpx. Cold-start is sub-second.

Invoke with:  modal run worker/admin.py::<entrypoint_name> --<args>
No `modal deploy` needed — `modal run` spins up an ephemeral app.
"""

from __future__ import annotations

import os

import modal

image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "httpx",
    "supabase==2.11.0",
)

app = modal.App("sing-anything-admin", image=image)


@app.function(secrets=[modal.Secret.from_name("supabase")], timeout=120)
def purge_user_attempts(email: str) -> dict:
    """Nuke every attempts row + audio file owned by the user with the
    given auth email. Library / songs / phrases are preserved; only
    practice recordings (and their pitch_analysis + feedback_text) get
    removed.

    Run via:
        modal run worker/admin.py::purge_user_attempts_run --email <email>
    """
    import httpx
    from supabase import create_client

    sb = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )

    # Look up the user via Supabase Auth admin API. Pass the email filter
    # so we don't scan every user in the project.
    resp = httpx.get(
        f"{os.environ['SUPABASE_URL']}/auth/v1/admin/users",
        headers={
            "apikey": os.environ["SUPABASE_SERVICE_ROLE_KEY"],
            "Authorization": f"Bearer {os.environ['SUPABASE_SERVICE_ROLE_KEY']}",
        },
        params={"email": email},
        timeout=10.0,
    )
    if resp.status_code != 200:
        return {"error": f"auth admin API {resp.status_code}: {resp.text[:200]}"}

    payload = resp.json()
    users = payload.get("users", []) if isinstance(payload, dict) else payload
    matches = [u for u in users if u.get("email", "").lower() == email.lower()]
    if not matches:
        return {"error": f"no user with email={email!r}"}
    user_id = matches[0]["id"]

    # Collect audio paths first, then storage-delete + row-delete.
    attempts = (
        sb.table("attempts")
        .select("id, audio_path")
        .eq("user_id", user_id)
        .execute()
    )
    rows = attempts.data or []
    audio_paths = [r["audio_path"] for r in rows if r.get("audio_path")]

    storage_errors: list[str] = []
    if audio_paths:
        BATCH = 100
        for i in range(0, len(audio_paths), BATCH):
            batch = audio_paths[i : i + BATCH]
            try:
                sb.storage.from_("attempts").remove(batch)
            except Exception as e:
                storage_errors.append(str(e))

    deleted = sb.table("attempts").delete().eq("user_id", user_id).execute()

    return {
        "user_id": user_id,
        "email": email,
        "rows_deleted": len(deleted.data or rows),
        "storage_paths_attempted": len(audio_paths),
        "storage_errors": storage_errors,
    }


@app.local_entrypoint()
def purge_user_attempts_run(email: str) -> None:
    import json as _json
    print(_json.dumps(purge_user_attempts.remote(email=email), indent=2))
