# Agent vocal SSP

L’outil de l’assurance envoie une demande de rappel au serveur SSP. Le serveur déclenche un appel sortant via Twilio Programmable Voice. L’agent se présente en français, demande l’accord du client, recueille le besoin et le créneau de rappel, puis produit un compte rendu pour le collaborateur. Le dialogue suit un scénario de qualification et de transfert à l’équipe.

## Démarrage

1. Installer Node.js 24 ou plus récent et exécuter `npm test`.
2. Configurer un numéro Twilio Voice et les autorisations d’appels vers les pays concernés.
3. Définir les variables de `.env.example` dans le gestionnaire de secrets de l’hébergeur. Pour un essai local, créer un fichier `.env` privé et lancer `node --env-file=.env server.js`.
4. Exposer le serveur derrière HTTPS à l’origine exacte définie dans `PUBLIC_BASE_URL`. Conserver le chemin et la chaîne de requête dans les redirections du proxy. Le serveur fournit lui-même les URL de rappel à Twilio.
5. Monter le répertoire SQLite sur un volume persistant et exécuter une seule instance. Restreindre l’accès au fichier, configurer les sauvegardes et définir la durée de conservation avec l’assurance.
6. Ouvrir l’interface avec l’utilisateur `ssp` et le mot de passe `DASHBOARD_PASSWORD`. `GET /health` indique si les paramètres téléphoniques sont présents. Un appel sur un numéro autorisé valide ensuite la connexion réelle jusqu’au compte rendu.

## Raccordement à l’outil de l’assurance

Envoyer une requête `POST /api/leads` avec `Authorization: Bearer <CRM_TOKEN>` et `Content-Type: application/json`.

```json
{
  "externalId": "DOSSIER-42-RAPPEL-1",
  "phone": "+33199000001",
  "name": "Camille",
  "callbackAuthorized": true
}
```

Utiliser une référence stable et unique par demande de rappel. Le serveur exige l’autorisation de rappel et vérifie la liste des numéros ayant demandé à être retirés. Une nouvelle demande acceptée renvoie `202`. Répéter la même référence renvoie l’état existant sans déclencher un nouvel appel. Un `502` signale un envoi à vérifier auprès du fournisseur avant toute nouvelle tentative.

Lire le résultat via `GET /api/leads?externalId=DOSSIER-42-RAPPEL-1` avec le même jeton. Le résultat comprend l’état de l’appel et, si disponible, le besoin et le créneau exprimés. L’interface affiche les 100 appels les plus récents.

## Validation

`npm test` vérifie le raccordement HTTP avec un fournisseur substitué, les signatures de rappel, l’idempotence, la persistance, la clôture et l’exclusion d’un numéro. Effectuer un appel de recette avec le compte Twilio et les flux de l’assurance avant l’ouverture aux clients.

## Hébergement Render

Le blueprint `render.yaml` configure un service Node, un contrôle de santé et un disque persistant SQLite. Il utilise l’offre payante Starter. Le serveur utilise l’adresse HTTPS fournie par Render, avec `PUBLIC_BASE_URL` comme override pour un domaine personnalisé. Render génère les secrets du tableau de bord et de l’API. Renseigner les paramètres Twilio dans le tableau de bord Render.
