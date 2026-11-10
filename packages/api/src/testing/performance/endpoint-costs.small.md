# Endpoint storage costs: small

5 projects × 10 notebooks; 2,000 terminal + 5 live sessions.
Each call costs one simulated round trip of 25 ms. CPU, compute and network transfer time are excluded.
Rounds include the first I/O round. Calls/round lists parallel widths in order; 16×3 means three rounds of 16 calls.
Cold uses fresh services; warm repeats on the same services. Each scenario starts from an independent copy of the fixture.

<!-- prettier-ignore -->
| Endpoint/scenario | Cache | Work | Storage calls | Rounds | Est. ms @25ms | Operations | Calls/round |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| GET /me | cold | response | 13 | 9 | 225 | get: 9, get304: 1, head: 2, put: 1 | 1×8, 5 |
| GET /me | cold | deferred | 0 | 0 | 0 | — | — |
| GET /me | warm | response | 7 | 3 | 75 | get304: 6, head: 1 | 1×2, 5 |
| GET /me | warm | deferred | 0 | 0 | 0 | — | — |
| GET /me (erin: app-user in every project) | cold | response | 13 | 9 | 225 | get: 9, get304: 1, head: 2, put: 1 | 1×8, 5 |
| GET /me (erin: app-user in every project) | cold | deferred | 0 | 0 | 0 | — | — |
| GET /me (erin: app-user in every project) | warm | response | 7 | 3 | 75 | get304: 6, head: 1 | 1×2, 5 |
| GET /me (erin: app-user in every project) | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects | cold | response | 12 | 8 | 200 | get: 9, get304: 1, head: 1, put: 1 | 1×7, 5 |
| GET /projects | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects | warm | response | 6 | 2 | 50 | get304: 6 | 1, 5 |
| GET /projects | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects (owner of all) | cold | response | 7 | 7 | 175 | get: 4, get304: 1, head: 1, put: 1 | 1×7 |
| GET /projects (owner of all) | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects (owner of all) | warm | response | 1 | 1 | 25 | get304: 1 | 1 |
| GET /projects (owner of all) | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid} | cold | response | 7 | 7 | 175 | get: 5, head: 1, put: 1 | 1×7 |
| GET /projects/{pid} | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid} | warm | response | 1 | 1 | 25 | get: 1 | 1 |
| GET /projects/{pid} | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/notebooks | cold | response | 8 | 8 | 200 | get: 5, get304: 1, head: 1, put: 1 | 1×8 |
| GET /projects/{pid}/notebooks | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/notebooks | warm | response | 2 | 2 | 50 | get: 1, get304: 1 | 1×2 |
| GET /projects/{pid}/notebooks | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/notebooks/{nid} | cold | response | 10 | 8 | 200 | get: 8, head: 1, put: 1 | 1×7, 3 |
| GET /projects/{pid}/notebooks/{nid} | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/notebooks/{nid} | warm | response | 4 | 2 | 50 | get: 4 | 1, 3 |
| GET /projects/{pid}/notebooks/{nid} | warm | deferred | 0 | 0 | 0 | — | — |
| GET …/notebooks/{nid}/content | cold | response | 11 | 9 | 225 | get: 9, head: 1, put: 1 | 1×7, 3, 1 |
| GET …/notebooks/{nid}/content | cold | deferred | 0 | 0 | 0 | — | — |
| GET …/notebooks/{nid}/content | warm | response | 5 | 3 | 75 | get: 5 | 1, 3, 1 |
| GET …/notebooks/{nid}/content | warm | deferred | 0 | 0 | 0 | — | — |
| GET /apps?project_id=&limit=20 | cold | response | 18 | 9 | 225 | get: 15, get304: 1, head: 1, put: 1 | 1×8, 10 |
| GET /apps?project_id=&limit=20 | cold | deferred | 0 | 0 | 0 | — | — |
| GET /apps?project_id=&limit=20 | warm | response | 12 | 3 | 75 | get: 1, get304: 11 | 1×2, 10 |
| GET /apps?project_id=&limit=20 | warm | deferred | 0 | 0 | 0 | — | — |
| GET /apps?limit=20 (unscoped) | cold | response | 38 | 12 | 300 | get: 34, get304: 2, head: 1, put: 1 | 1×7, 5, 1, 4, 16, 5 |
| GET /apps?limit=20 (unscoped) | cold | deferred | 0 | 0 | 0 | — | — |
| GET /apps?limit=20 (unscoped) | warm | response | 32 | 6 | 150 | get: 4, get304: 28 | 1, 5, 1, 4, 16, 5 |
| GET /apps?limit=20 (unscoped) | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/sessions | cold | response | 414 | 35 | 875 | get: 411, head: 1, list: 1, put: 1 | 1×8, 16×25, 3×2 |
| GET /projects/{pid}/sessions | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/sessions | warm | response | 5 | 3 | 75 | get: 4, list: 1 | 1×2, 3 |
| GET /projects/{pid}/sessions | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/thumbnails | cold | response | 18 | 9 | 225 | get: 15, get304: 1, head: 1, put: 1 | 1×8, 10 |
| GET /projects/{pid}/thumbnails | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/thumbnails | warm | response | 12 | 3 | 75 | get: 11, get304: 1 | 1×2, 10 |
| GET /projects/{pid}/thumbnails | warm | deferred | 0 | 0 | 0 | — | — |
| GET …/notebooks/{nid}/thumbnail | cold | response | 9 | 9 | 225 | get: 7, head: 1, put: 1 | 1×9 |
| GET …/notebooks/{nid}/thumbnail | cold | deferred | 0 | 0 | 0 | — | — |
| GET …/notebooks/{nid}/thumbnail | warm | response | 3 | 3 | 75 | get: 2, get304: 1 | 1×3 |
| GET …/notebooks/{nid}/thumbnail | warm | deferred | 0 | 0 | 0 | — | — |
| GET /search?q=revenue | cold | response | 115 | 16 | 400 | get: 49, get304: 4, head: 61, put: 1 | 1×7, 5, 2, 28×2, 14, 1, 12×2, 6 |
| GET /search?q=revenue | cold | deferred | 0 | 0 | 0 | — | — |
| GET /search?q=revenue | warm | response | 109 | 10 | 250 | get: 40, get304: 9, head: 60 | 1, 5, 2, 28×2, 14, 1, 12×2, 6 |
| GET /search?q=revenue | warm | deferred | 0 | 0 | 0 | — | — |
| GET /search?q=&project_id= | cold | response | 58 | 14 | 350 | get: 25, get304: 1, head: 31, put: 1 | 1×8, 16×2, 8, 4×2, 2 |
| GET /search?q=&project_id= | cold | deferred | 0 | 0 | 0 | — | — |
| GET /search?q=&project_id= | warm | response | 52 | 8 | 200 | get: 20, get304: 2, head: 30 | 1×2, 16×2, 8, 4×2, 2 |
| GET /search?q=&project_id= | warm | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (edit; cold=create, warm=reuse) | cold | response | 2447 | 178 | 4450 | get: 2024, get304: 406, head: 1, list: 7, put: 9 | 1×6, 4, 1×2, 16×25, 3, 2, 1×6, 16×100, 3, 16×25, 3, 1×4, 4, 5, 1×2, 3 |
| POST …/sessions (edit; cold=create, warm=reuse) | cold | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (edit; cold=create, warm=reuse) | warm | response | 8 | 5 | 125 | get: 6, get304: 1, list: 1 | 4, 1×4 |
| POST …/sessions (edit; cold=create, warm=reuse) | warm | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (edit; new notebook each call) | cold | response | 2447 | 178 | 4450 | get: 2024, get304: 406, head: 1, list: 7, put: 9 | 1×6, 4, 1×2, 16×25, 3, 2, 1×6, 16×100, 3, 16×25, 3, 1×4, 4, 5, 1×2, 3 |
| POST …/sessions (edit; new notebook each call) | cold | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (edit; new notebook each call) | warm | response | 30 | 16 | 400 | get: 15, get304: 4, list: 4, put: 7 | 4, 1×3, 2, 1×6, 4, 6, 1×2, 3 |
| POST …/sessions (edit; new notebook each call) | warm | deferred | 0 | 0 | 0 | — | — |
| GET …/sessions/{sid} | cold | response | 9 | 9 | 225 | get: 7, head: 1, put: 1 | 1×9 |
| GET …/sessions/{sid} | cold | deferred | 0 | 0 | 0 | — | — |
| GET …/sessions/{sid} | warm | response | 3 | 3 | 75 | get: 1, get304: 2 | 1×3 |
| GET …/sessions/{sid} | warm | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions/{sid}/heartbeat (edit) | cold | response | 9 | 8 | 200 | get: 7, head: 1, put: 1 | 1×6, 2, 1 |
| POST …/sessions/{sid}/heartbeat (edit) | cold | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions/{sid}/heartbeat (edit) | warm | response | 3 | 2 | 50 | get: 1, get304: 2 | 2, 1 |
| POST …/sessions/{sid}/heartbeat (edit) | warm | deferred | 0 | 0 | 0 | — | — |
| PATCH …/notebooks/{nid} {code} (no live editor) | cold | response | 435 | 51 | 1275 | get: 417, head: 1, list: 2, put: 15 | 1×10, 3, 1, 16×25, 3, 1×5, 6, 1×7 |
| PATCH …/notebooks/{nid} {code} (no live editor) | cold | deferred | 0 | 0 | 0 | — | — |
| PATCH …/notebooks/{nid} {code} (no live editor) | warm | response | 26 | 19 | 475 | get: 10, list: 2, put: 14 | 1×4, 3, 1×6, 6, 1×7 |
| PATCH …/notebooks/{nid} {code} (no live editor) | warm | deferred | 0 | 0 | 0 | — | — |
| periodic save: notebooks.commitSession (live editor) | cold | response | 21 | 13 | 325 | get: 10, list: 1, put: 10 | 3, 1, 2, 6, 1×9 |
| periodic save: notebooks.commitSession (live editor) | cold | deferred | 0 | 0 | 0 | — | — |
| periodic save: notebooks.commitSession (live editor) | warm | response | 20 | 12 | 300 | get: 9, list: 1, put: 10 | 3, 1, 2, 6, 1×8 |
| periodic save: notebooks.commitSession (live editor) | warm | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (app; cold=admit, warm=re-admit) | cold | response | 2447 | 182 | 4550 | get: 2027, get304: 402, head: 3, list: 8, put: 7 | 1×6, 4, 1×2, 16×25, 3, 1×3, 2, 1×5, 16×100, 3, 16×25, 1×4, 3×2, 2×2, 1, 2, 1×2 |
| POST …/sessions (app; cold=admit, warm=re-admit) | cold | deferred | 1 | 1 | 25 | put: 1 | 1 |
| POST …/sessions (app; cold=admit, warm=re-admit) | warm | response | 8 | 5 | 125 | get: 7, get304: 1 | 4, 1×4 |
| POST …/sessions (app; cold=admit, warm=re-admit) | warm | deferred | 0 | 0 | 0 | — | — |
