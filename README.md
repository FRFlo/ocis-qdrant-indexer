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

- **Événementiel & Temps réel :** Consomme le stream NATS JetStream `main-queue` utilisé par oCIS. Les événements métier (`events.UploadReady`, `events.FileUploaded`, `events.ItemTrashed`, `events.ItemPurged`) sont routés par `SpaceId` vers les seuls comptes inscrits qui y ont actuellement accès.
- **Rattrapage et mise à jour efficaces :** Au démarrage, réconcilie individuellement les utilisateurs enregistrés et leurs espaces accessibles. À la première requête, le compte ownCloud vérifié peut appeler `sync_owncloud_docs` pour indexer ses fichiers. Un SHA-256 du contenu est stocké avec chaque chunk ; les événements et scans suivants téléchargent le fichier pour vérifier ce hash.
- **Upsert propre & Zéro doublon :** Lorsqu'un fichier est modifié dans ownCloud, ses anciens vecteurs sont supprimés avant de réinsérer les nouveaux. En cas de suppression du fichier (`ItemTrashed` / `ItemPurged`), les vecteurs sont automatiquement purgés.
- **Embeddings sans coût VPS :** Utilise Cloudflare Workers AI (`@cf/baai/bge-m3`, multilingue, 1024 dimensions) dans la limite du Free Tier quotidien (~9M tokens/jour). Support alternatif pour OpenAI (`text-embedding-3-small`) ou Ollama local.
- **Extraction PDF :** Utilise [OpenDataLoader PDF](https://github.com/opendataloader-project/opendataloader-pdf) pour extraire le texte en Markdown, avec Java 11+ requis (inclus dans l'image Docker).
- **Extraction générique et OCR :** Les fichiers sont d’abord décodés en UTF-8 strict, sans se fier à leur extension. `TIKA_URL` (optionnel) tente l’extraction des contenus binaires ; lorsque le texte reste vide, `PADDLEOCR_URL` (optionnel) délègue les images et PDF scannés à PaddleOCR, avec un en-tête de page dans le texte indexé.
- **Découpage hiérarchique :** Parse le Markdown/GFM en AST, construit une arborescence H1 à H6 et répète les titres parents dans chaque chunk. Préserve les blocs sous le budget ; subdivise les blocs trop longs en conservant les en-têtes de tableaux. Le budget par défaut de 7 000 tokens est compté avec le tokenizer du modèle : tokenizer BGE-M3 officiel Hugging Face (révision épinglée) ou `cl100k_base` pour les modèles d’embedding OpenAI pris en charge. Les fichiers du tokenizer sont téléchargés puis mis en cache ; les modèles personnalisés doivent fournir leur identifiant Hugging Face dans `EMBEDDING_TOKENIZER_MODEL`.
- **Serveur MCP Streamable HTTP :** Expose `search_owncloud_docs` et `sync_owncloud_docs` sur `POST /mcp`. Chaque session est liée à un compte ownCloud validé et à sa collection Qdrant privée.
- **Isolation multi-utilisateur :** Les PATs sont stockés chiffrés avec AES-256-GCM; chaque utilisateur a une collection Qdrant distincte, filtrée par les espaces accessibles à son compte.

## Outil MCP disponible

### `search_owncloud_docs`

Recherche sémantique dans les cours et documents indexés depuis ownCloud.

- `query` (string, requis) : Question ou mots-clés de recherche.
- `limit` (number, optionnel, défaut : 5) : Nombre d'extraits pertinents à renvoyer.
- `path_prefix` (string, optionnel) : Filtre sur un sous-dossier (ex. `Cours/AP4/`).

### `sync_owncloud_docs`

Synchronise à la demande les fichiers accessibles par le compte authentifié vers son index privé, incluant les espaces personnels, partagés et projet que ce compte peut lire.

## Variables d'environnement

| Variable                        | Description                                                                            | Défaut                                      |
| ------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------- |
| `NATS_URL`                      | URL de connexion au bus NATS oCIS                                                      | `nats://owncloud:9233`                      |
| `QDRANT_URL`                    | URL de la base vectorielle Qdrant                                                      | `http://qdrant:6333`                        |
| `QDRANT_COLLECTION`             | Préfixe des collections Qdrant isolées par utilisateur                                 | `owncloud_documents`                        |
| `OCIS_WEBDAV_URL`               | Racine WebDAV oCIS (endpoint `.../dav/spaces/{space-id}` recommandé)                   | `http://owncloud:9200/remote.php/dav/files` |
| `OCIS_GRAPH_URL`                | Racine Graph API oCIS                                                                  | dérivée de `OCIS_WEBDAV_URL`                |
| `OCIS_REQUEST_TIMEOUT_MS`       | Délai maximal d'un téléchargement WebDAV (ms)                                          | `30000`                                     |
| `OCIS_MAX_FILE_SIZE_BYTES`      | Taille maximale téléchargée depuis WebDAV (octets)                                     | `52428800`                                  |
| `TIKA_URL`                      | URL de base facultative du serveur Apache Tika (`/tika/md` est ajouté automatiquement) | -                                           |
| `PADDLEOCR_URL`                 | URL facultative du service OCR PaddleOCR (ex. `http://paddleocr:8080`)                 | -                                           |
| `PADDLEOCR_TIMEOUT_MS`          | Délai maximal d'une requête OCR (ms)                                                   | `300000`                                    |
| `EMBEDDING_PROVIDER`            | Provider d'embedding (`cloudflare`, `openai`, `ollama`)                                | `cloudflare`                                |
| `EMBEDDING_MAX_TOKENS`          | Nombre maximal exact de tokens par chunk, comptés par le tokenizer du modèle           | `7000`                                      |
| `EMBEDDING_TOKENIZER_MODEL`     | Identifiant Hugging Face du tokenizer d'un modèle personnalisé                         | -                                           |
| `EMBEDDING_TOKENIZER_REVISION`  | Révision Hugging Face du tokenizer personnalisé                                        | `main`                                      |
| `EMBEDDING_TOKENIZER_CACHE_DIR` | Répertoire local de cache des fichiers tokenizer                                       | `~/.cache/ocis-qdrant-indexer/tokenizers`   |
| `CLOUDFLARE_ACCOUNT_ID`         | ID de compte Cloudflare                                                                | -                                           |
| `CLOUDFLARE_API_TOKEN`          | Jeton API Cloudflare Workers AI                                                        | -                                           |
| `CLOUDFLARE_MODEL`              | Modèle d'embedding Cloudflare                                                          | `@cf/baai/bge-m3`                           |
| `MCP_PORT`                      | Port d'écoute du serveur MCP                                                           | `3000`                                      |
| `USER_STORE_PATH`               | Fichier SQLite durable des utilisateurs, PATs chiffrés et espaces accessibles          | `/data/users.sqlite`                        |
| `USER_STORE_ENCRYPTION_KEY`     | Clé AES-256-GCM stable (32 octets en base64 ou 64 caractères hex)                      | requis                                      |

Pour indexer un espace oCIS, définissez `OCIS_WEBDAV_URL` sur son endpoint
`/dav/spaces/{space-id}/`. L'indexeur ajoute les chemins de fichiers à cette
racine avec le PAT du compte authentifié. Pour l'endpoint
`/remote.php/dav/files`, le nom d'utilisateur authentifié est ajouté au chemin.

Le MCP exige HTTP Basic avec le **nom d'utilisateur ownCloud et son PAT personnel**.
Les identifiants sont vérifiés auprès de Graph (`/me`, `/me/drives`); le PAT est
ensuite conservé chiffré afin que le worker NATS puisse traiter les événements.
Activez `auth-app` pour les PATs ownCloud. Le serveur doit être exposé uniquement
via HTTPS (par exemple derrière un reverse proxy TLS), car Basic transmet le PAT
à chaque requête.

Montez un volume Docker persistant sur `/data` pour conserver `users.sqlite`.
Fournissez `USER_STORE_ENCRYPTION_KEY` depuis un gestionnaire de secrets, pas
depuis le dépôt. Sauvegardez le fichier SQLite et la clé séparément; la perte ou
la rotation non coordonnée de la clé rend les PATs déjà persistés illisibles.
NATS garde son mécanisme d'authentification propre, configuré via `NATS_URL`;
un PAT ownCloud n'authentifie pas une connexion NATS.

Les décisions d'architecture et les critères d'acceptation multi-utilisateur
sont décrits dans [`docs/multi-user-architecture.md`](docs/multi-user-architecture.md)
et [`docs/multi-user-spec.md`](docs/multi-user-spec.md).

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

Pour l'OCR local, le dépôt fournit un service CPU dans `paddleocr/`. Il accepte
les images PNG/JPEG/WebP/TIFF/BMP et les PDF jusqu'à 100 pages et 50 Mio par
fichier. Les PDF passent d'abord par OpenDataLoader ; PaddleOCR n'est sollicité
que si cette extraction est vide. Les images passent directement par PaddleOCR
lorsque le service est configuré ; les autres fichiers binaires passent par
Tika, puis par PaddleOCR si Tika n'extrait aucun texte. Les résultats sont repérés par page. L'indexeur
n'envoie de fichier au service que lorsque `PADDLEOCR_URL` est explicitement
défini. En production, utilisez le service privé `paddleocr` de la stack VPS et
montez un volume Docker persistant sur `/models` dans Dockhand : PaddleOCR y
conserve ses poids dans `/models/.paddleocr`, ce qui évite de les télécharger à
chaque recréation du conteneur. Le premier téléchargement peut retarder son état
healthy.

Les clients MCP doivent envoyer `Authorization: Basic <base64(username:PAT)>`
sur `/mcp` (et `/api/v1/mcp`). Les sessions sont refusées si un autre compte
ownCloud réutilise leur `mcp-session-id`.

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
