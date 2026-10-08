# Elio — chatbot de pré-diagnostic robotisation

Prototype pédagogique (cours de design conversationnel, ECE). Non affilié à Elio Robot.

## Lancer l'application

1. **Installer Node.js** (une seule fois) : https://nodejs.org, version « LTS ».
2. **Vérifier la clé API** dans le fichier `.env` (ligne `NVIDIA_API_KEY=`).
   Le fichier `.env` est masqué sur Mac : dans le Finder, appuyez sur Cmd + Maj + . pour l'afficher.
   Après un clonage depuis GitHub, `.env` n'existe pas (la clé n'est jamais publiée) : copiez `.env.example` en `.env` (`cp .env.example .env`) puis collez votre clé.
3. **Démarrer** :
   - Mac : double-cliquez sur `Lancer Elio (Mac).command`. La première fois, si macOS bloque le fichier : clic droit > Ouvrir > Ouvrir.
   - Windows : double-cliquez sur `Lancer Elio (Windows).bat`.
   - Ou dans un terminal, depuis ce dossier : `node server.js`
4. Le navigateur s'ouvre sur http://localhost:3000. Laissez la fenêtre du serveur ouverte pendant la démo.

Au démarrage, le terminal affiche si la clé API est acceptée. L'interface affiche aussi un bandeau en cas de problème.

## Modifier le comportement d'Elio

- **Le prompt système** est dans `system-prompt.txt`. Il est relu à chaque message : modifiez-le, enregistrez, puis cliquez sur « Recommencer » dans l'interface. Pas besoin de relancer le serveur.
- **Le modèle** se change dans `.env` (ligne `MODEL=`), avec l'identifiant exact affiché sur build.nvidia.com. Relancez ensuite le serveur.
  Par défaut : `nvidia/nemotron-3-super-120b-a12b` (rapide, bon suivi du prompt en français).
- **Les modèles de secours** (`FALLBACK_MODELS=`, séparés par des virgules) prennent le relais automatiquement si le modèle principal est retiré par NVIDIA ou ne répond pas sous 20 secondes. Par défaut : `openai/gpt-oss-20b`.
- **La réflexion du modèle** (`THINKING=false`) : les modèles « raisonneurs » réfléchissent plusieurs secondes avant d'écrire. Elle est désactivée pour que la conversation reste fluide.
- **La température** (`TEMPERATURE=0.4`) : plus basse, Elio est plus régulier ; plus haute, plus varié.

## Problèmes fréquents

| Message | Solution |
|---|---|
| « La clé API a été refusée par NVIDIA » | La clé est invalide ou expirée. Créez-en une sur build.nvidia.com (elle commence par `nvapi-`) et collez-la dans `.env`. |
| « Le modèle … n'est plus disponible » | NVIDIA retire régulièrement des modèles. Remplacez `MODEL=` dans `.env` par un modèle listé sur build.nvidia.com, ou ajoutez-en un dans `FALLBACK_MODELS=`. |
| « Le service NVIDIA est saturé » | L'offre gratuite de NVIDIA est parfois surchargée. Réessayez dans quelques instants. |
| « Le port 3000 est déjà utilisé » | L'application tourne déjà : ouvrez http://localhost:3000. Sinon changez `PORT=` dans `.env`. |
| Le logo et la mascotte n'apparaissent pas | Ils sont téléchargés depuis elio-robot.fr au premier lancement. Sans connexion, une illustration de remplacement s'affiche. |

## Architecture (pour l'oral)

```
Navigateur (public/)          Serveur local (server.js)           API NVIDIA
interface de chat   --->   ajoute le prompt système      --->   modèle de langage
boutons, parcours   <---   garde la clé API secrète      <---   réponse en continu
```

- La clé API ne quitte jamais le serveur : elle n'est pas visible dans le navigateur.
- Le serveur n'a aucune dépendance à installer (Node.js 18 ou plus).
- L'interface transforme la réponse du modèle en expérience :
  - les options numérotées deviennent des **boutons de réponse rapide** ;
  - « Question X/5 » fait avancer le **robot sur le parcours** ; si Elio rend son verdict plus tôt, les étapes sautées restent en pointillé ;
  - « Verdict : … » devient un **badge coloré** (vert, orange, gris) ;
  - le récapitulatif a un bouton **Copier**, et un bouton unique **copie le récapitulatif et ouvre le formulaire Elio**.
- Pensée pour l'expérience utilisateur :
  - la réponse s'affiche **mot à mot** ; le bouton d'envoi devient **Stop** pendant qu'Elio écrit (un arrêt avant le début de la réponse rend la question à la zone de saisie) ;
  - **Modifier ma réponse** sous le dernier message permet de corriger une réponse sans recommencer ;
  - la conversation est **conservée si la page est rechargée** ; « Recommencer » demande une confirmation ;
  - **raccourcis clavier** : Entrée pour envoyer, touches 1 à 7 pour choisir une option ; une option « Autre (précisez) » ouvre la saisie ;
  - **mode sombre** (bouton lune/soleil, sinon réglage du système), affichage adapté au **mobile** ;
  - si on remonte lire l'historique, le fil ne saute pas : un bouton « Dernier message » apparaît.
- Les couleurs reprennent celles de la mascotte (orange) et du logo (bleu nuit), avec des contrastes lisibles.
