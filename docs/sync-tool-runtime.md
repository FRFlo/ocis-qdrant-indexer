# Diagnostic du tool de synchronisation MCP

## Éléments observés

Le client a retourné `Internal tool error [5225f429]` avec une trace dans
`executor-quickjs-runtime.js`. Ce message provient du runtime du client et ne
contient ni code d'erreur MCP, ni délai dépassé, ni trace du serveur. Le dépôt
ne contient pas les journaux de l'hôte Executor permettant de corréler cet
identifiant.

## Cause applicative plausible, mais non confirmée

Avant la correction, le gestionnaire MCP attendait `await userIndexer.sync(...)`
avant de répondre. Cette méthode attend l'énumération des espaces, puis les
téléchargements, l'extraction et l'indexation de chaque fichier. Un espace avec
beaucoup de fichiers, une requête WebDAV lente ou un service d'extraction ou
d'embedding lent pouvait donc garder l'appel MCP ouvert longtemps.

Un dépassement de délai côté client est une explication plausible de l'erreur,
mais le dépôt ne permet pas de confirmer que c'est la cause exacte : le délai
maximal du runtime QuickJS et les journaux correspondant à l'identifiant
`5225f429` ne sont pas disponibles. Les conditions de charge ci-dessus sont des
conditions susceptibles de prolonger l'appel, pas une reproduction prouvée de
l'erreur du client.

## Reproduction et correction vérifiables dans le dépôt

- `src/user-indexer.test.ts` garde l'énumération WebDAV en attente et vérifie que
  `startSync` répond `started`, puis `already_running`, sans attendre la fin de
  l'indexation.
- `src/mcp.test.ts` appelle le tool via le SDK MCP et un transport en mémoire,
  puis vérifie la réponse MCP immédiate.
- Le tool `sync_owncloud_docs` démarre désormais l'indexation en arrière-plan.
  Les journaux du service donnent le résultat final ou une erreur assainie.

Ces tests vérifient le comportement corrigé et l'absence d'attente sur le scan ;
ils ne reproduisent pas l'erreur interne de l'hôte QuickJS. Pour diagnostiquer
cette erreur de façon concluante, il faut les journaux Executor autour de
`5225f429` et, si disponible, le délai d'exécution appliqué à cet appel.
