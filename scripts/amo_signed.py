# /// script
# requires-python = ">=3.14"
# dependencies = ["pyjwt>=2.9", "cyclopts>=4"]
# ///
"""Download the package addons.mozilla.org signed for one version of an add-on.

AMO signs each version once. When a signing run uploads a version but loses the answer, the
next run's submission is refused ("Version ... already exists"), so provision asks for the
signed package first. Credentials are MOZILLA_JWT_ISSUER and MOZILLA_JWT_SECRET, AMO's JWT
API key (https://mozilla.github.io/addons-server/topics/api/auth.html).

Exits 0 with the package written to OUT, 2 when AMO holds no signed package of that version.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

import jwt
from cyclopts import App

API = "https://addons.mozilla.org/api/v5"
NOT_SIGNED = 2

app = App()


def authorized(url: str) -> Request:
    now = int(time.time())
    token = jwt.encode(
        {
            "iss": os.environ["MOZILLA_JWT_ISSUER"],
            "jti": str(uuid.uuid4()),
            "iat": now,
            "exp": now + 60,
        },
        os.environ["MOZILLA_JWT_SECRET"],
        algorithm="HS256",
    )
    return Request(url, headers={"Authorization": f"JWT {token}"})


@app.default
def main(addon_id: str, version: str, out: Path) -> None:
    try:
        with urlopen(authorized(f"{API}/addons/addon/{quote(addon_id)}/versions/v{version}/")) as response:
            file = json.load(response)["file"]
    except HTTPError as error:
        if error.code == 404:
            sys.exit(NOT_SIGNED)
        raise
    if file["status"] != "public":
        sys.exit(NOT_SIGNED)
    with urlopen(authorized(file["url"])) as response:
        package = response.read()
    algorithm, digest = file["hash"].split(":")
    if hashlib.new(algorithm, package).hexdigest() != digest:
        sys.exit(f"amo_signed: {file['url']} does not match the hash AMO gives for it")
    out.write_bytes(package)


if __name__ == "__main__":
    app()
