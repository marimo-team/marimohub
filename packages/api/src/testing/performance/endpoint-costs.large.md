# Endpoint storage costs: large

200 projects × 50 notebooks; 2,000 terminal + 5 live sessions.
Each call costs one simulated round trip of 25 ms. CPU, compute and network transfer time are excluded.
Rounds include the first I/O round. Calls/round lists parallel widths in order; 16×3 means three rounds of 16 calls.
Cold uses fresh services; warm repeats on the same services. Each scenario starts from an independent copy of the fixture.

<!-- prettier-ignore -->
| Endpoint/scenario | Cache | Work | Storage calls | Rounds | Est. ms @25ms | Operations | Calls/round |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| GET /me | cold | response | 24 | 9 | 225 | get: 20, get304: 1, head: 2, put: 1 | 1×8, 16 |
| GET /me | cold | deferred | 0 | 0 | 0 | — | — |
| GET /me | warm | response | 18 | 3 | 75 | get304: 17, head: 1 | 1×2, 16 |
| GET /me | warm | deferred | 0 | 0 | 0 | — | — |
| GET /me (erin: app-user in every project) | cold | response | 208 | 21 | 525 | get: 204, get304: 1, head: 2, put: 1 | 1×8, 16×12, 8 |
| GET /me (erin: app-user in every project) | cold | deferred | 0 | 0 | 0 | — | — |
| GET /me (erin: app-user in every project) | warm | response | 202 | 15 | 375 | get304: 201, head: 1 | 1×2, 16×12, 8 |
| GET /me (erin: app-user in every project) | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects | cold | response | 157 | 17 | 425 | get: 154, get304: 1, head: 1, put: 1 | 1×7, 16×9, 6 |
| GET /projects | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects | warm | response | 151 | 11 | 275 | get304: 151 | 1, 16×9, 6 |
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
| GET /apps?project_id=&limit=20 | cold | response | 58 | 12 | 300 | get: 55, get304: 1, head: 1, put: 1 | 1×8, 16×3, 2 |
| GET /apps?project_id=&limit=20 | cold | deferred | 0 | 0 | 0 | — | — |
| GET /apps?project_id=&limit=20 | warm | response | 52 | 6 | 150 | get: 51, get304: 1 | 1×2, 16×3, 2 |
| GET /apps?project_id=&limit=20 | warm | deferred | 0 | 0 | 0 | — | — |
| GET /apps?limit=20 (unscoped) | cold | response | 7808 | 637 | 15925 | get: 7804, get304: 2, head: 1, put: 1 | 1×7, 16×9, 6, 1×151, 16×468, 12 |
| GET /apps?limit=20 (unscoped) | cold | deferred | 0 | 0 | 0 | — | — |
| GET /apps?limit=20 (unscoped) | warm | response | 7802 | 631 | 15775 | get: 7650, get304: 152 | 1, 16×9, 6, 1×151, 16×468, 12 |
| GET /apps?limit=20 (unscoped) | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/sessions | cold | response | 214 | 22 | 550 | get: 211, head: 1, list: 1, put: 1 | 1×8, 16×12, 11, 3 |
| GET /projects/{pid}/sessions | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/sessions | warm | response | 5 | 3 | 75 | get: 4, list: 1 | 1×2, 3 |
| GET /projects/{pid}/sessions | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/thumbnails | cold | response | 58 | 10 | 250 | get: 55, get304: 1, head: 1, put: 1 | 1×8, 32, 18 |
| GET /projects/{pid}/thumbnails | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/thumbnails | warm | response | 52 | 4 | 100 | get: 51, get304: 1 | 1×2, 32, 18 |
| GET /projects/{pid}/thumbnails | warm | deferred | 0 | 0 | 0 | — | — |
| GET …/notebooks/{nid}/thumbnail | cold | response | 9 | 9 | 225 | get: 7, head: 1, put: 1 | 1×9 |
| GET …/notebooks/{nid}/thumbnail | cold | deferred | 0 | 0 | 0 | — | — |
| GET …/notebooks/{nid}/thumbnail | warm | response | 3 | 3 | 75 | get: 2, get304: 1 | 1×3 |
| GET …/notebooks/{nid}/thumbnail | warm | deferred | 0 | 0 | 0 | — | — |
| GET /search?q=revenue | cold | response | 983 | 100 | 2500 | get: 884, get304: 37, head: 61, put: 1 | 1×7, 8×5, 16×6, 4, 16×6, 4, 16×6, 4, 16×6, 4, 16×6, 4, 16×6, 4, 16×6, 4, 16×6, 4, 2, 4, 8, 12, 2, 4, 8, 12, 2×2, 4, 6, 2×2, 4, 6, 2×2, 4, 6, 2×2, 4, 6, 2×2, 4, 6, 2×2, 4, 6 |
| GET /search?q=revenue | cold | deferred | 0 | 0 | 0 | — | — |
| GET /search?q=revenue | warm | response | 977 | 94 | 2350 | get: 40, get304: 877, head: 60 | 1, 8×5, 16×6, 4, 16×6, 4, 16×6, 4, 16×6, 4, 16×6, 4, 16×6, 4, 16×6, 4, 16×6, 4, 2, 4, 8, 12, 2, 4, 8, 12, 2×2, 4, 6, 2×2, 4, 6, 2×2, 4, 6, 2×2, 4, 6, 2×2, 4, 6, 2×2, 4, 6 |
| GET /search?q=revenue | warm | deferred | 0 | 0 | 0 | — | — |
| GET /search?q=&project_id= | cold | response | 178 | 24 | 600 | get: 95, get304: 21, head: 61, put: 1 | 1×7, 8×6, 2, 1, 8, 16, 24, 8, 16, 24, 4, 8, 12 |
| GET /search?q=&project_id= | cold | deferred | 0 | 0 | 0 | — | — |
| GET /search?q=&project_id= | warm | response | 172 | 18 | 450 | get: 40, get304: 72, head: 60 | 1, 8×6, 2, 1, 8, 16, 24, 8, 16, 24, 4, 8, 12 |
| GET /search?q=&project_id= | warm | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (edit; cold=create, warm=reuse) | cold | response | 2036 | 148 | 3700 | get: 2021, head: 1, list: 7, put: 7 | 1×6, 4, 1×2, 16×12, 11, 2, 1×2, 16×112, 10, 1×4, 3, 2, 1×3, 3 |
| POST …/sessions (edit; cold=create, warm=reuse) | cold | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (edit; cold=create, warm=reuse) | warm | response | 8 | 5 | 125 | get: 6, get304: 1, list: 1 | 4, 1×4 |
| POST …/sessions (edit; cold=create, warm=reuse) | warm | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (edit; new notebook each call) | cold | response | 2036 | 148 | 3700 | get: 2021, head: 1, list: 7, put: 7 | 1×6, 4, 1×2, 16×12, 11, 2, 1×2, 16×112, 10, 1×4, 3, 2, 1×3, 3 |
| POST …/sessions (edit; new notebook each call) | cold | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (edit; new notebook each call) | warm | response | 26 | 17 | 425 | get: 12, get304: 1, list: 7, put: 6 | 4, 1×3, 2, 1×6, 3, 2, 1×3, 3 |
| POST …/sessions (edit; new notebook each call) | warm | deferred | 0 | 0 | 0 | — | — |
| GET …/sessions/{sid} | cold | response | 9 | 9 | 225 | get: 7, head: 1, put: 1 | 1×9 |
| GET …/sessions/{sid} | cold | deferred | 0 | 0 | 0 | — | — |
| GET …/sessions/{sid} | warm | response | 3 | 3 | 75 | get: 1, get304: 2 | 1×3 |
| GET …/sessions/{sid} | warm | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions/{sid}/heartbeat (edit) | cold | response | 10 | 9 | 225 | get: 8, head: 1, put: 1 | 1×6, 2, 1×2 |
| POST …/sessions/{sid}/heartbeat (edit) | cold | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions/{sid}/heartbeat (edit) | warm | response | 4 | 3 | 75 | get: 2, get304: 2 | 2, 1×2 |
| POST …/sessions/{sid}/heartbeat (edit) | warm | deferred | 0 | 0 | 0 | — | — |
| PATCH …/notebooks/{nid} {code} (no live editor) | cold | response | 235 | 38 | 950 | get: 217, head: 1, list: 2, put: 15 | 1×10, 3, 1, 16×12, 11, 1×5, 6, 1×7 |
| PATCH …/notebooks/{nid} {code} (no live editor) | cold | deferred | 0 | 0 | 0 | — | — |
| PATCH …/notebooks/{nid} {code} (no live editor) | warm | response | 26 | 19 | 475 | get: 10, list: 2, put: 14 | 1×4, 3, 1×6, 6, 1×7 |
| PATCH …/notebooks/{nid} {code} (no live editor) | warm | deferred | 0 | 0 | 0 | — | — |
| periodic save: notebooks.commitSession (live editor) | cold | response | 21 | 13 | 325 | get: 10, list: 1, put: 10 | 3, 1, 2, 6, 1×9 |
| periodic save: notebooks.commitSession (live editor) | cold | deferred | 0 | 0 | 0 | — | — |
| periodic save: notebooks.commitSession (live editor) | warm | response | 20 | 12 | 300 | get: 9, list: 1, put: 10 | 3, 1, 2, 6, 1×8 |
| periodic save: notebooks.commitSession (live editor) | warm | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (app; cold=admit, warm=re-admit) | cold | response | 2040 | 151 | 3775 | get: 2024, head: 3, list: 8, put: 5 | 1×6, 4, 1×2, 16×12, 11, 1×3, 2, 1×2, 16×112, 10, 1×2, 2×3, 3, 1, 2, 1×2 |
| POST …/sessions (app; cold=admit, warm=re-admit) | cold | deferred | 1 | 1 | 25 | put: 1 | 1 |
| POST …/sessions (app; cold=admit, warm=re-admit) | warm | response | 8 | 5 | 125 | get: 7, get304: 1 | 4, 1×4 |
| POST …/sessions (app; cold=admit, warm=re-admit) | warm | deferred | 0 | 0 | 0 | — | — |
