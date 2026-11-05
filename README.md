# Suivi des déchets · campagne 2026

Tableau de bord statique (HTML, CSS, JavaScript vanilla, aucune dépendance, aucun serveur) qui reprend le classeur template Trackdéchet.

## Fonctionnement

1. On importe l'onglet **« Import Track Déchet »** exporté en CSV. Le fichier remplace les données.
2. L'application recalcule les vues qui correspondent aux autres onglets du classeur, et les complète :
   - **Synthèse** : quantité réceptionnée réelle, valorisée, éliminée, non traitée, refusée.
   - **Par dénomination** : quantités par dénomination usuelle, avec le détail par code déchet (dépliable).
   - **Par expéditeur** : quantités par expéditeur (« DD par agence »), avec le détail par dénomination.
   - **Dénomination × traitement** : matrice des quantités par code de traitement réalisé.
   - **Valorisation** : lignes valorisées, ventilées par expéditeur et par code R.
   - **Lignes** : toutes les lignes filtrées, triables, exportables.
3. Filtres communs à toutes les vues : **expéditeur** (choix multiple avec recherche), dénomination, statut, type de bordereau, période d'expédition, recherche libre.

## Règles de calcul

| Indicateur | Définition |
|---|---|
| Réceptionné (réel) | Somme de « Quantité réceptionnée nette (tonnes) » |
| Valorisé | Lignes dont « Code(s) de traitement réalisé(s) » contient un code **R** (R1, R3, R4, R5, R9, R12, R13…) |
| Éliminé | Lignes dont le code de traitement contient un code **D** et aucun code R |
| Non traité / en cours | Les autres lignes (en attente de réception, annulées, refusées sans traitement…) |
| Refusé | Somme de « Quantité refusée nette (tonnes) » |

Contrôle sur le classeur de la campagne (836 lignes) : 1 256,625 t réceptionnées, dont 1 056,453 t valorisées. Ces totaux sont ceux des onglets d'origine.

## Utilisation

- Ouvrir le site, cliquer sur **Importer un CSV** (ou glisser le fichier dans la page).
- Le fichier est lu dans le navigateur. Il est mémorisé localement (`localStorage`) pour rester disponible après un rechargement. Le bouton **Effacer les données** le retire.
- Dans Excel : Fichier › Enregistrer sous › *CSV UTF-8 (délimité par des virgules)*. Le format point-virgule est aussi accepté ; le séparateur et l'encodage sont détectés automatiquement.

## Lancer en local

Ouvrir `index.html` dans un navigateur, ou lancer un petit serveur statique, par exemple `npx serve .`.

## Publier sur Netlify

- **Sans Git** : glisser le dossier sur https://app.netlify.com/drop.
- **Avec Git** : pousser le dépôt, créer un site Netlify. Build command vide, Publish directory `.`. Le fichier `netlify.toml` configure ce réglage et des en-têtes de sécurité (noindex, CSP).

## Confidentialité

- Aucune donnée n'est envoyée à un serveur : tout reste dans le navigateur de l'utilisateur.
- Le `.gitignore` exclut les fichiers `.csv`. Ne pas les ajouter au dépôt : ils contiennent des noms et adresses e-mail de contacts.
- Pour restreindre l'accès au site lui-même, utiliser la protection par mot de passe proposée par Netlify (offre payante).

## Structure

```
index.html          interface
css/style.css       mise en forme
js/csv.js           lecture du CSV (séparateur, guillemets, encodage)
js/model.js         colonnes reconnues, règles de classement, agrégats
js/app.js           filtres, vues, exports
netlify.toml        publication et en-têtes
```


## Version 2

- Filtres à choix multiples : expéditeur (nom usuel), expéditeur (raison sociale), lieu de collecte (« Expéditeur - Référence du chantier / lieu de collecte »), entreprise de travaux (raison sociale) et destination (nom usuel, « Destination - Nom usuel »).
- Import de fichiers : le format est vérifié avant lecture. Un CSV d'un autre séparateur ou encodage est converti en CSV UTF-8 à virgules. Un classeur `.xlsx` est lu directement (premier onglet). Les `.xls` et `.ods` doivent être réenregistrés en `.xlsx` ou exportés en CSV. Le détail des vérifications figure dans « Données importées ».
