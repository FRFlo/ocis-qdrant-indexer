# ocis-qdrant-indexer

Sidecar temps réel d'ingestion et de recherche sémantique (RAG) pour **ownCloud Infinite Scale (oCIS)**, **Qdrant** et **Cloudflare Workers AI**, avec serveur **MCP Streamable HTTP** intégré pour les agents IA (Hermes, Claude, Cursor, Executor).

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                        STACK DOCKER                         │
│                                                             │
│   ownCloud (oCIS)                                           │
│       │                                                     │
│       │ (Événements oCIS sur le stream JetStream main-queue)│
│       ▼                                                     │
│   [ocis-qdrant-indexer] (Ce sidecar)                        │
│       ├── 1. Télécharge le document via WebDAV              │
│       ├── 2. Extrait le texte (PDF, MD, Code, etc.)         │
│       ├── 3. Découpe en chunks + Embedding (Cloudflare)     │
│       └── 4. Upsert atomique (purge des anciens chunks)     │
│       ▼                                                     │
│   Qdrant (Base vectorielle)                                 │
│       ▲                                                     │
│       │ (Streamable HTTP MCP POST /mcp)                     │
│   Hermes / Executor MCP Client                              │
└─────────────────────────────────────────────────────────────┘
```

## Fonctionnalités

- **Événementiel & Temps réel :** Consomme le stream NATS JetStream `main-queue` utilisé par oCIS. Les événements métier (`events.UploadReady`, `events.FileUploaded`, `events.ItemTrashed`, `events.ItemPurged`) sont lus depuis les métadonnées du message. Aucun polling ou cron requis.
- **Rattrapage et mise à jour efficaces :** Au démarrage, parcourt récursivement l'espace WebDAV de `OCIS_USERNAME` pour indexer les documents pris en charge déjà présents. Un SHA-256 du contenu est stocké avec chaque chunk ; les événements et scans suivants téléchargent le fichier pour vérifier ce hash, mais ne recalculent pas les embeddings si le contenu n'a pas changé.
- **Upsert propre & Zéro doublon :** Lorsqu'un fichier est modifié dans ownCloud, ses anciens vecteurs sont supprimés avant de réinsérer les nouveaux. En cas de suppression du fichier (`ItemTrashed` / `ItemPurged`), les vecteurs sont automatiquement purgés.
- **Embeddings sans coût VPS :** Utilise Cloudflare Workers AI (`@cf/baai/bge-m3`, multilingue, 1024 dimensions) dans la limite du Free Tier quotidien (~9M tokens/jour). Support alternatif pour OpenAI (`text-embedding-3-small`) ou Ollama local.
- **Extraction PDF :** Utilise [OpenDataLoader PDF](https://github.com/opendataloader-project/opendataloader-pdf) pour extraire le texte en Markdown, avec Java 11+ requis (inclus dans l'image Docker).
- **Extraction générique :** Les fichiers sont d’abord décodés en UTF-8 strict, sans se fier à leur extension. Pour tout contenu binaire, `TIKA_URL` (optionnel) permet de tenter une extraction via un serveur Apache Tika ; sans Tika ou si aucun texte n’est extractible, le fichier n’est pas indexé.
- **Serveur MCP Streamable HTTP :** Expose nativement l'outil `search_owncloud_docs` sur `POST /mcp` compatible avec Executor, Claude Desktop et Hermes Agent.

## Outil MCP disponible

### `search_owncloud_docs`

Recherche sémantique dans les cours et documents indexés depuis ownCloud.

- `query` (string, requis) : Question ou mots-clés de recherche.
- `limit` (number, optionnel, défaut : 5) : Nombre d'extraits pertinents à renvoyer.
- `path_prefix` (string, optionnel) : Filtre sur un sous-dossier (ex. `Cours/AP4/`).

## Variables d'environnement

| Variable                   | Description                                                                            | Défaut                                      |
| -------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------- |
| `NATS_URL`                 | URL de connexion au bus NATS oCIS                                                      | `nats://owncloud:9233`                      |
| `QDRANT_URL`               | URL de la base vectorielle Qdrant                                                      | `http://qdrant:6333`                        |
| `QDRANT_COLLECTION`        | Nom de la collection vectorielle                                                       | `owncloud_documents`                        |
| `OCIS_WEBDAV_URL`          | Racine WebDAV oCIS (endpoint `.../dav/spaces/{space-id}` recommandé)                   | `http://owncloud:9200/remote.php/dav/files` |
| `OCIS_USERNAME`            | Nom d'utilisateur oCIS                                                                 | `admin`                                     |
| `OCIS_PASSWORD`            | Mot de passe oCIS (authentification Basic WebDAV)                                      | -                                           |
| `OCIS_TOKEN`               | Jeton WebDAV oCIS (Bearer ou jeton d'application)                                      | -                                           |
| `OCIS_REQUEST_TIMEOUT_MS`  | Délai maximal d'un téléchargement WebDAV (ms)                                          | `30000`                                     |
| `OCIS_MAX_FILE_SIZE_BYTES` | Taille maximale téléchargée depuis WebDAV (octets)                                     | `52428800`                                  |
| `TIKA_URL`                 | URL de base facultative du serveur Apache Tika (`/tika/md` est ajouté automatiquement) | -                                           |
| `EMBEDDING_PROVIDER`       | Provider d'embedding (`cloudflare`, `openai`, `ollama`)                                | `cloudflare`                                |
| `CLOUDFLARE_ACCOUNT_ID`    | ID de compte Cloudflare                                                                | -                                           |
| `CLOUDFLARE_API_TOKEN`     | Jeton API Cloudflare Workers AI                                                        | -                                           |
| `CLOUDFLARE_MODEL`         | Modèle d'embedding Cloudflare                                                          | `@cf/baai/bge-m3`                           |
| `MCP_PORT`                 | Port d'écoute du serveur MCP                                                           | `3000`                                      |
| `MCP_AUTH_TOKEN`           | Jeton Bearer facultatif pour protéger les routes MCP                                   | - (authentification désactivée)             |

Pour indexer un espace oCIS, définissez `OCIS_WEBDAV_URL` sur son endpoint
`/dav/spaces/{space-id}/`. L'indexeur ajoute les chemins de fichiers à cette
racine. L'ancien endpoint `/remote.php/dav/files` reste compatible et reçoit
automatiquement `OCIS_USERNAME` dans son chemin.

L'indexeur doit disposer de `OCIS_TOKEN` ou de `OCIS_PASSWORD`. Le jeton est
d'abord envoyé en Bearer ; en cas de `401`, il est réessayé en Basic comme mot de
passe d'application oCIS. Pour Basic, le nom d'utilisateur doit correspondre au
compte qui possède l'espace WebDAV ciblé. Les jetons d'application oCIS sont
utilisés comme mot de passe Basic ; le serveur oCIS doit avoir `auth-app` activé.

Dans Docker Compose, protégez le `$` du space ID contre l'interpolation en
utilisant une valeur entre apostrophes simples, par exemple :
`OCIS_WEBDAV_URL: 'https://owncloud.example.org/dav/spaces/<space-id>/'`.

En exécution hors Docker, PDF nécessite Java 11 ou ultérieur accessible dans le
`PATH` pour OpenDataLoader PDF.

Pour l'extraction des contenus binaires, configurez si besoin un serveur Apache
Tika avec `TIKA_URL=http://tika:9998`. Le service tente alors l'endpoint
`PUT /tika/md` pour recevoir le résultat en Markdown, quel que soit le suffixe. Si Tika ne renvoie aucun texte ou signale
une erreur de parsing (400, 415, 422 ou 500), le fichier est journalisé comme
non parseable et ignoré. Les erreurs de disponibilité du serveur (réseau,
429, 503, etc.) restent des erreurs d'indexation et sont réessayées.

Lorsque `MCP_AUTH_TOKEN` est défini, les clients doivent envoyer
`Authorization: Bearer <jeton>` sur `/mcp` (et `/api/v1/mcp`). Sans cette variable,
les routes MCP restent accessibles sans authentification. Gardez le port MCP sur
un réseau de confiance si l'authentification est désactivée.

## Développement local

```bash
# Installation des dépendances
bun install

# Lancement des tests
bun test

# Formatage et Lint
bun run fmt
bun run lint

# Démarrage en mode dev
bun run dev
```

## Licence

MIT © [FRFlo](https://github.com/FRFlo)
