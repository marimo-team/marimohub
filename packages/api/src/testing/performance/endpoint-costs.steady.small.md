# Endpoint storage costs: steady.small

5 projects × 10 notebooks; 2,000 terminal + 5 live sessions.
Each call costs one simulated round trip of 25 ms. CPU, compute and network transfer time are excluded.
Rounds include the first I/O round. Calls/round lists parallel widths in order; 16×3 means three rounds of 16 calls.
Cold uses fresh services; warm repeats on the same services. Each scenario starts from an independent copy of the fixture.

Session index: on and backfilled. Access summaries: refreshed with matching generation. Core deferred work: enabled.

<!-- prettier-ignore -->
| Endpoint/scenario | Cache | Work | Storage calls | Rounds | Est. ms @25ms | Operations | Calls/round |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| GET /me | cold | response | 7 | 7 | 175 | get: 4, get304: 1, head: 2 | 1×7 |
| GET /me | cold | deferred | 0 | 0 | 0 | — | — |
| GET /me | warm | response | 2 | 2 | 50 | get304: 1, head: 1 | 1×2 |
| GET /me | warm | deferred | 0 | 0 | 0 | — | — |
| GET /me (erin: app-user in every project) | cold | response | 7 | 7 | 175 | get: 4, get304: 1, head: 2 | 1×7 |
| GET /me (erin: app-user in every project) | cold | deferred | 0 | 0 | 0 | — | — |
| GET /me (erin: app-user in every project) | warm | response | 2 | 2 | 50 | get304: 1, head: 1 | 1×2 |
| GET /me (erin: app-user in every project) | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects | cold | response | 6 | 6 | 150 | get: 4, get304: 1, head: 1 | 1×6 |
| GET /projects | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects | warm | response | 1 | 1 | 25 | get304: 1 | 1 |
| GET /projects | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects (owner of all) | cold | response | 6 | 6 | 150 | get: 4, get304: 1, head: 1 | 1×6 |
| GET /projects (owner of all) | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects (owner of all) | warm | response | 1 | 1 | 25 | get304: 1 | 1 |
| GET /projects (owner of all) | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid} | cold | response | 6 | 6 | 150 | get: 5, head: 1 | 1×6 |
| GET /projects/{pid} | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid} | warm | response | 1 | 1 | 25 | get: 1 | 1 |
| GET /projects/{pid} | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/notebooks | cold | response | 7 | 7 | 175 | get: 5, get304: 1, head: 1 | 1×7 |
| GET /projects/{pid}/notebooks | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/notebooks | warm | response | 2 | 2 | 50 | get: 1, get304: 1 | 1×2 |
| GET /projects/{pid}/notebooks | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/notebooks/{nid} | cold | response | 9 | 7 | 175 | get: 8, head: 1 | 1×6, 3 |
| GET /projects/{pid}/notebooks/{nid} | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/notebooks/{nid} | warm | response | 4 | 2 | 50 | get: 4 | 1, 3 |
| GET /projects/{pid}/notebooks/{nid} | warm | deferred | 0 | 0 | 0 | — | — |
| GET …/notebooks/{nid}/content | cold | response | 10 | 8 | 200 | get: 9, head: 1 | 1×6, 3, 1 |
| GET …/notebooks/{nid}/content | cold | deferred | 0 | 0 | 0 | — | — |
| GET …/notebooks/{nid}/content | warm | response | 5 | 3 | 75 | get: 5 | 1, 3, 1 |
| GET …/notebooks/{nid}/content | warm | deferred | 0 | 0 | 0 | — | — |
| GET /apps?project_id=&limit=20 | cold | response | 17 | 8 | 200 | get: 15, get304: 1, head: 1 | 1×7, 10 |
| GET /apps?project_id=&limit=20 | cold | deferred | 0 | 0 | 0 | — | — |
| GET /apps?project_id=&limit=20 | warm | response | 12 | 3 | 75 | get: 1, get304: 11 | 1×2, 10 |
| GET /apps?project_id=&limit=20 | warm | deferred | 0 | 0 | 0 | — | — |
| GET /apps?limit=20 (unscoped) | cold | response | 32 | 10 | 250 | get: 29, get304: 2, head: 1 | 1×7, 4, 16, 5 |
| GET /apps?limit=20 (unscoped) | cold | deferred | 0 | 0 | 0 | — | — |
| GET /apps?limit=20 (unscoped) | warm | response | 27 | 5 | 125 | get: 4, get304: 23 | 1×2, 4, 16, 5 |
| GET /apps?limit=20 (unscoped) | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/sessions | cold | response | 213 | 21 | 525 | get: 211, head: 1, list: 1 | 1×7, 16×12, 11, 3 |
| GET /projects/{pid}/sessions | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/sessions | warm | response | 5 | 3 | 75 | get: 4, list: 1 | 1×2, 3 |
| GET /projects/{pid}/sessions | warm | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/thumbnails | cold | response | 17 | 8 | 200 | get: 15, get304: 1, head: 1 | 1×7, 10 |
| GET /projects/{pid}/thumbnails | cold | deferred | 0 | 0 | 0 | — | — |
| GET /projects/{pid}/thumbnails | warm | response | 12 | 3 | 75 | get: 11, get304: 1 | 1×2, 10 |
| GET /projects/{pid}/thumbnails | warm | deferred | 0 | 0 | 0 | — | — |
| GET …/notebooks/{nid}/thumbnail | cold | response | 8 | 8 | 200 | get: 7, head: 1 | 1×8 |
| GET …/notebooks/{nid}/thumbnail | cold | deferred | 0 | 0 | 0 | — | — |
| GET …/notebooks/{nid}/thumbnail | warm | response | 3 | 3 | 75 | get: 2, get304: 1 | 1×3 |
| GET …/notebooks/{nid}/thumbnail | warm | deferred | 0 | 0 | 0 | — | — |
| GET /search?q=revenue | cold | response | 76 | 15 | 375 | get: 48, get304: 7, head: 21 | 1×6, 4, 2, 1, 2, 28, 14, 1, 12, 6 |
| GET /search?q=revenue | cold | deferred | 0 | 0 | 0 | — | — |
| GET /search?q=revenue | warm | response | 71 | 10 | 250 | get: 40, get304: 11, head: 20 | 1, 4, 2, 1, 2, 28, 14, 1, 12, 6 |
| GET /search?q=revenue | warm | deferred | 0 | 0 | 0 | — | — |
| GET /search?q=revenue&project_id= | cold | response | 38 | 12 | 300 | get: 25, get304: 2, head: 11 | 1×8, 16, 8, 4, 2 |
| GET /search?q=revenue&project_id= | cold | deferred | 0 | 0 | 0 | — | — |
| GET /search?q=revenue&project_id= | warm | response | 33 | 7 | 175 | get: 20, get304: 3, head: 10 | 1×3, 16, 8, 4, 2 |
| GET /search?q=revenue&project_id= | warm | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (edit; cold=create, warm=reuse) | cold | response | 236 | 34 | 850 | get: 226, head: 1, list: 1, put: 8 | 1×5, 4, 1×2, 16×12, 11, 2, 1×5, 3, 4, 1×2, 2, 1, 3 |
| POST …/sessions (edit; cold=create, warm=reuse) | cold | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (edit; cold=create, warm=reuse) | warm | response | 7 | 4 | 100 | get: 6, get304: 1 | 4, 1×3 |
| POST …/sessions (edit; cold=create, warm=reuse) | warm | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (edit; new notebook each call) | cold | response | 236 | 34 | 850 | get: 226, head: 1, list: 1, put: 8 | 1×5, 4, 1×2, 16×12, 11, 2, 1×5, 3, 4, 1×2, 2, 1, 3 |
| POST …/sessions (edit; new notebook each call) | cold | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (edit; new notebook each call) | warm | response | 30 | 17 | 425 | get: 17, get304: 4, list: 1, put: 8 | 4, 1×3, 2, 1×5, 3, 5, 1×2, 2, 1, 3 |
| POST …/sessions (edit; new notebook each call) | warm | deferred | 0 | 0 | 0 | — | — |
| GET …/sessions/{sid} | cold | response | 8 | 8 | 200 | get: 7, head: 1 | 1×8 |
| GET …/sessions/{sid} | cold | deferred | 0 | 0 | 0 | — | — |
| GET …/sessions/{sid} | warm | response | 3 | 3 | 75 | get: 1, get304: 2 | 1×3 |
| GET …/sessions/{sid} | warm | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions/{sid}/heartbeat (edit) | cold | response | 8 | 7 | 175 | get: 7, head: 1 | 1×5, 2, 1 |
| POST …/sessions/{sid}/heartbeat (edit) | cold | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions/{sid}/heartbeat (edit) | warm | response | 3 | 2 | 50 | get: 1, get304: 2 | 2, 1 |
| POST …/sessions/{sid}/heartbeat (edit) | warm | deferred | 0 | 0 | 0 | — | — |
| PATCH …/notebooks/{nid} {code} (no live editor) | cold | response | 232 | 38 | 950 | get: 219, head: 1, list: 1, put: 11 | 1×9, 3, 1×2, 16×12, 11, 1×6, 3, 1×6 |
| PATCH …/notebooks/{nid} {code} (no live editor) | cold | deferred | 5 | 5 | 125 | get: 2, list: 2, put: 1 | 1×5 |
| PATCH …/notebooks/{nid} {code} (no live editor) | warm | response | 24 | 20 | 500 | get: 12, list: 1, put: 11 | 1×4, 3, 1×8, 3, 1×6 |
| PATCH …/notebooks/{nid} {code} (no live editor) | warm | deferred | 5 | 5 | 125 | get: 2, list: 2, put: 1 | 1×5 |
| periodic save: notebooks.commitSession (live editor) | cold | response | 20 | 13 | 325 | get: 10, head: 3, put: 7 | 3, 1, 2, 3×2, 1×8 |
| periodic save: notebooks.commitSession (live editor) | cold | deferred | 5 | 5 | 125 | get: 2, list: 2, put: 1 | 1×5 |
| periodic save: notebooks.commitSession (live editor) | warm | response | 19 | 12 | 300 | get: 9, head: 3, put: 7 | 3, 1, 2, 3×2, 1×7 |
| periodic save: notebooks.commitSession (live editor) | warm | deferred | 5 | 5 | 125 | get: 2, list: 2, put: 1 | 1×5 |
| POST …/sessions (app; cold=admit, warm=re-admit) | cold | response | 234 | 38 | 950 | get: 224, head: 3, list: 2, put: 5 | 1×5, 4, 1×2, 16×12, 11, 1×3, 2, 1×8, 2, 1, 2, 1×2 |
| POST …/sessions (app; cold=admit, warm=re-admit) | cold | deferred | 1 | 1 | 25 | put: 1 | 1 |
| POST …/sessions (app; cold=admit, warm=re-admit) | warm | response | 8 | 5 | 125 | get: 7, get304: 1 | 4, 1×4 |
| POST …/sessions (app; cold=admit, warm=re-admit) | warm | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (edit; existing claimed editor) | cold | response | 12 | 9 | 225 | get: 11, head: 1 | 1×5, 4, 1×3 |
| POST …/sessions (edit; existing claimed editor) | cold | deferred | 0 | 0 | 0 | — | — |
| POST …/sessions (edit; existing claimed editor) | warm | response | 7 | 4 | 100 | get: 6, get304: 1 | 4, 1×3 |
| POST …/sessions (edit; existing claimed editor) | warm | deferred | 0 | 0 | 0 | — | — |
| periodic save: unchanged code (live editor) | cold | response | 13 | 8 | 200 | get: 9, head: 3, put: 1 | 3, 1, 2, 3, 1×4 |
| periodic save: unchanged code (live editor) | cold | deferred | 0 | 0 | 0 | — | — |
| periodic save: unchanged code (live editor) | warm | response | 10 | 6 | 150 | get: 5, get304: 1, head: 3, put: 1 | 3, 1, 3, 1×3 |
| periodic save: unchanged code (live editor) | warm | deferred | 0 | 0 | 0 | — | — |
