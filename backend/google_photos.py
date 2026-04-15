import json
import urllib.parse
import httpx
from datetime import datetime, timezone
from typing import Callable


class GooglePhotosService:
    _AUTH_URL = "https://accounts.google.com/o/oauth2/auth"
    _TOKEN_URL = "https://oauth2.googleapis.com/token"
    _UPLOAD_URL = "https://photoslibrary.googleapis.com/v1/uploads"
    _MEDIA_URL = "https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate"
    _ALBUMS_URL = "https://photoslibrary.googleapis.com/v1/albums"
    SCOPE = "https://www.googleapis.com/auth/photoslibrary.appendonly"

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        redirect_uri: str,
        tokens: dict | None = None,
        on_tokens_updated: Callable[[dict], None] | None = None,
    ):
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self.tokens = tokens or {}
        self.on_tokens_updated = on_tokens_updated
        self._album_cache: dict[str, str] = {}  # title -> album_id

    def get_auth_url(self) -> str:
        params = {
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
            "scope": self.SCOPE,
            "access_type": "offline",
            "prompt": "consent",
        }
        return f"{self._AUTH_URL}?{urllib.parse.urlencode(params)}"

    async def exchange_code(self, code: str) -> dict:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.post(self._TOKEN_URL, data={
                "code": code,
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "redirect_uri": self.redirect_uri,
                "grant_type": "authorization_code",
            })
            data = r.json()
        if "access_token" in data:
            data["expires_at"] = datetime.now(timezone.utc).timestamp() + data.get("expires_in", 3600)
            self.tokens = data
            if self.on_tokens_updated:
                self.on_tokens_updated(data)
        return data

    async def _get_access_token(self) -> str:
        expires_at = self.tokens.get("expires_at", 0)
        if datetime.now(timezone.utc).timestamp() < expires_at - 60:
            return self.tokens["access_token"]
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.post(self._TOKEN_URL, data={
                "refresh_token": self.tokens["refresh_token"],
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "grant_type": "refresh_token",
            })
            data = r.json()
        self.tokens["access_token"] = data["access_token"]
        self.tokens["expires_at"] = datetime.now(timezone.utc).timestamp() + data.get("expires_in", 3600)
        if self.on_tokens_updated:
            self.on_tokens_updated(self.tokens)
        return self.tokens["access_token"]

    async def _get_or_create_album(self, title: str, token: str) -> str:
        if title in self._album_cache:
            return self._album_cache[title]
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{self._ALBUMS_URL}?pageSize=50",
                                 headers={"Authorization": f"Bearer {token}"})
            for album in r.json().get("albums", []):
                if album.get("title") == title:
                    self._album_cache[title] = album["id"]
                    return album["id"]
            r = await client.post(self._ALBUMS_URL,
                                  headers={"Authorization": f"Bearer {token}"},
                                  json={"album": {"title": title}})
            album_id = r.json()["id"]
        self._album_cache[title] = album_id
        return album_id

    async def upload_photo(self, img_bytes: bytes, album_name: str = "",
                           filename: str = "photo.jpg") -> bool:
        try:
            token = await self._get_access_token()
            async with httpx.AsyncClient(timeout=30.0) as client:
                # Step 1: upload bytes → get upload token
                r = await client.post(
                    self._UPLOAD_URL,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/octet-stream",
                        "X-Goog-Upload-Content-Type": "image/jpeg",
                        "X-Goog-Upload-Protocol": "raw",
                        "X-Goog-Upload-File-Name": filename,
                    },
                    content=img_bytes,
                )
                if r.status_code != 200:
                    print(f"[google-photos] upload step failed ({r.status_code}): {r.text[:200]}", flush=True)
                    return False
                upload_token = r.text.strip()
                if not upload_token:
                    print("[google-photos] upload step returned empty token", flush=True)
                    return False
                # Step 2: create media item
                body: dict = {"newMediaItems": [{"simpleMediaItem": {
                    "uploadToken": upload_token,
                    "fileName": filename,
                }}]}
                if album_name:
                    body["albumId"] = await self._get_or_create_album(album_name, token)
                r = await client.post(
                    self._MEDIA_URL,
                    headers={"Authorization": f"Bearer {token}"},
                    json=body,
                )
            data = r.json()
            results = data.get("newMediaItemResults", [])
            if not results:
                print(f"[google-photos] batchCreate failed ({r.status_code}): {data}", flush=True)
                return False
            status = results[0].get("status", {})
            ok = status.get("message") == "Success" or status.get("code") in (0, None)
            if not ok:
                print(f"[google-photos] media item rejected: {status}", flush=True)
            return ok
        except Exception as e:
            print(f"[google-photos] upload_photo error: {e}", flush=True)
            return False
