import json

import pytest
from fastapi.testclient import TestClient
from pdfs import filler, make_pdf

from leqtern import main
from leqtern.config import Settings
from leqtern.saved import SavedWorkspace


@pytest.fixture
def client(tmp_path):
    services = main.Services(Settings(data_dir=tmp_path, anthropic_api_key=None))
    main.app.dependency_overrides[main.get_services] = lambda: services
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def test_nothing_saved_yet_is_an_empty_workspace(client: TestClient) -> None:
    assert client.get("/api/workspace").json() == {"revision": 0}


def test_a_saved_workspace_comes_back(client: TestClient, tmp_path) -> None:
    workspace = {"version": 1, "topics": [{"id": "t1", "name": "Calculus", "chat": []}]}
    response = client.put("/api/workspace?base=0&writer=a", json=workspace)
    assert response.status_code == 200
    assert response.json()["revision"] == 1
    assert client.get("/api/workspace").json() == {**workspace, "revision": 1}
    assert SavedWorkspace(tmp_path / "workspace.json").load() == workspace
    assert not (tmp_path / "workspace.tmp").exists()


def test_a_workspace_saved_before_revisions_still_loads(tmp_path) -> None:
    workspace = {"version": 1, "topics": []}
    (tmp_path / "workspace.json").write_text(json.dumps(workspace))
    saved = SavedWorkspace(tmp_path / "workspace.json")
    assert saved.load() == workspace
    assert saved.revision() == 0
    assert saved.save({"version": 1, "topics": [{"id": "t"}]}, base=0, writer="a") == 1


def test_a_tab_working_from_an_older_copy_cannot_save_over_another_tabs_save(
    client: TestClient,
) -> None:
    first = {"version": 1, "topics": [{"id": "t1"}]}
    assert client.put("/api/workspace?base=0&writer=a", json=first).json()["revision"] == 1
    # Tab b loads revision 1 and saves; tab a, still on revision 1, then tries to save.
    second = {"version": 1, "topics": [{"id": "t1"}, {"id": "t2"}]}
    assert client.put("/api/workspace?base=1&writer=b", json=second).json()["revision"] == 2
    stale = client.put("/api/workspace?base=1&writer=a", json=first)
    assert stale.status_code == 409
    assert client.get("/api/workspace").json() == {**second, "revision": 2}


def test_a_tabs_own_saves_can_overtake_each_other(client: TestClient) -> None:
    # Two saves sent before either came back are both based on revision 0.
    assert client.put("/api/workspace?base=0&writer=a", json={"n": 1}).status_code == 200
    assert client.put("/api/workspace?base=0&writer=a", json={"n": 2}).status_code == 200
    assert client.get("/api/workspace").json() == {"n": 2, "revision": 2}


def test_other_sites_and_hosts_are_turned_away(client: TestClient) -> None:
    data = make_pdf([filler("limits")])
    pdf = {"Content-Type": "application/pdf"}
    evil = {**pdf, "Origin": "https://evil.example"}
    assert client.post("/api/docs?name=a.pdf", content=data, headers=evil).status_code == 403
    # A plain cross-site request can only send text/plain, which uploads refuse.
    plain = {"Content-Type": "text/plain"}
    assert client.post("/api/docs?name=a.pdf", content=data, headers=plain).status_code == 415
    rebound = {**pdf, "Host": "attacker.example"}
    assert client.get("/api/workspace", headers={"Host": "attacker.example"}).status_code == 403
    assert client.post("/api/docs?name=a.pdf", content=data, headers=rebound).status_code == 403
    local = {**pdf, "Origin": "http://localhost:5173", "Host": "localhost:5173"}
    assert client.post("/api/docs?name=a.pdf", content=data, headers=local).status_code == 200
    assert client.get("/api/workspace", headers={"Host": "127.0.0.1:8000"}).status_code == 200
    assert client.get("/api/workspace", headers={"Host": "[::1]:8000"}).status_code == 200


def test_a_stored_pdf_can_be_downloaded_again(client: TestClient) -> None:
    data = make_pdf([filler("limits")])
    doc_id = client.post(
        "/api/docs?name=a.pdf", content=data, headers={"Content-Type": "application/pdf"}
    ).json()["id"]
    response = client.get(f"/api/docs/{doc_id}/pdf")
    assert response.status_code == 200
    assert response.content == data
    assert client.get("/api/docs/0000000000000000/pdf").status_code == 404


@pytest.fixture
def services(tmp_path):
    services = main.Services(Settings(data_dir=tmp_path, anthropic_api_key=None))
    main.app.dependency_overrides[main.get_services] = lambda: services
    yield services
    main.app.dependency_overrides.clear()


def topic(topic_id: str, *server_ids: str) -> dict:
    docs = [{"id": f"tab-{s}", "name": "a.pdf", "serverId": s} for s in server_ids]
    return {"id": topic_id, "name": topic_id, "docs": docs, "chats": []}


def upload(client: TestClient, services, text: str, long_ago: bool = True) -> str:
    data = make_pdf([filler(text)])
    headers = {"Content-Type": "application/pdf"}
    doc_id = client.post("/api/docs?name=a.pdf", content=data, headers=headers).json()["id"]
    if long_ago:
        services.library.added_at[doc_id] = 0
    return doc_id


def test_a_pdf_taken_out_of_its_only_topic_is_deleted_with_the_save(services) -> None:
    client = TestClient(main.app)
    kept, gone = upload(client, services, "kept"), upload(client, services, "gone")
    saved = client.put(
        f"/api/workspace?base=0&writer=a&release={gone}",
        json={"version": 1, "topics": [topic("t1", kept)]},
    ).json()
    assert saved["deleted"] == [gone] and saved["later"] == []
    assert not services.library.folder(gone).exists()
    assert client.get(f"/api/docs/{gone}/pdf").status_code == 404
    assert client.get(f"/api/docs/{gone}").status_code == 404
    assert client.get(f"/api/docs/{kept}/pdf").status_code == 200


def test_a_pdf_still_in_another_topic_is_kept(services) -> None:
    client = TestClient(main.app)
    shared = upload(client, services, "shared")
    saved = client.put(
        f"/api/workspace?release={shared}",
        json={"version": 1, "topics": [topic("t1"), topic("t2", shared)]},
    ).json()
    assert saved["deleted"] == []
    assert client.get(f"/api/docs/{shared}/pdf").status_code == 200


def test_a_pdf_added_moments_ago_is_deleted_later(services) -> None:
    client = TestClient(main.app)
    new = upload(client, services, "new", long_ago=False)
    saved = client.put(f"/api/workspace?release={new}", json={"version": 1, "topics": []}).json()
    assert saved == {"status": "saved", "revision": 1, "deleted": [], "later": [new]}
    assert services.library.folder(new).exists()


def test_a_refused_save_deletes_nothing(services) -> None:
    client = TestClient(main.app)
    doc = upload(client, services, "doc")
    client.put("/api/workspace?base=0&writer=b", json={"version": 1, "topics": [topic("t", doc)]})
    stale = client.put(
        f"/api/workspace?base=0&writer=a&release={doc}", json={"version": 1, "topics": []}
    )
    assert stale.status_code == 409
    assert services.library.folder(doc).exists()
