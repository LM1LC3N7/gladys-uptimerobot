# UptimeRobot

Vos moniteurs [UptimeRobot](https://uptimerobot.com) dans Gladys, par l'API
officielle d'UptimeRobot et une clé d'API de votre compte. Chaque moniteur
devient un appareil Gladys :

- **Online** : 1 en ligne, 0 hors ligne (confirmé par UptimeRobot) ; rien
  tant que le moniteur est en pause ou pas encore vérifié ;
- **Status** : `up`, `seems_down` (semble hors ligne, pas encore confirmé),
  `down`, `paused` ou `not_checked` ;
- **Response time** : le dernier temps de réponse mesuré, en millisecondes ;
- **Uptime 24 h (%)**, **Uptime 7 days (%)** et **Uptime 30 days (%)** : la
  disponibilité des dernières 24 heures, 7 et 30 jours ;
- les boutons **Pause monitoring** et **Resume monitoring**, seulement si vous
  les autorisez (voir Pause et reprise).

Le type du moniteur (HTTP(s), Keyword, Ping, Port, Heartbeat) et sa cible
apparaissent dans les paramètres de l'appareil : seulement le protocole et
l'hôte (par exemple `https://exemple.fr`), jamais le chemin, les paramètres ni
d'éventuels identifiants de l'adresse, et jamais l'adresse secrète d'un
moniteur Heartbeat.

> **Cette intégration n'a jamais été testée avec un vrai compte UptimeRobot.**
> Cette première version a été écrite à partir de la documentation officielle
> de l'API UptimeRobot, et testée seulement contre un faux UptimeRobot. Dites
> sur le forum de Gladys ce qui marche et ce qui ne marche pas.

Intégration non officielle, sans lien avec UptimeRobot.

## Créer une clé en lecture seule (recommandé)

Gladys n'a besoin que de lire : utilisez la **clé d'API en lecture seule**
(« Read-only API key »), qui ne peut ni modifier ni supprimer vos moniteurs.

1. Connectez-vous sur [uptimerobot.com](https://dashboard.uptimerobot.com).
2. Ouvrez **Integrations & API**, puis la section **API**.
3. À la ligne **Read-only API key**, cliquez sur **Create** (ou affichez la
   clé existante) et copiez-la.
4. Collez-la dans le champ **Clé d'API** de l'intégration et enregistrez.

La clé principale (« Main API key ») marche aussi, mais elle peut tout
changer dans le compte : ne la donnez que si vous voulez la pause et la
reprise. Une clé propre à un moniteur (« Monitor-specific API key ») ne lit
que ce moniteur.

La clé est gardée par Gladys dans sa base, jamais réaffichée, envoyée
seulement à `api.uptimerobot.com`, dans le corps des requêtes (jamais dans une
adresse, jamais dans un journal, jamais dans le volume `/data`).

## Configuration

- **Clé d'API** : voir ci-dessus.
- **Moniteurs** (facultatif) : les identifiants des moniteurs à suivre (les
  chiffres à la fin de l'adresse d'un moniteur sur le tableau de bord),
  séparés par des virgules, 50 au plus. Vide : tous les moniteurs du compte,
  200 au plus.
- **Rafraîchissement** : toutes les 5 minutes par défaut (de chaque minute à
  chaque heure). Chaque lecture fait une requête par tranche de 50 moniteurs.
  L'offre gratuite vérifie vos sites toutes les 5 minutes : lire plus souvent
  ne sert qu'avec une offre payante.
- **Autoriser la pause et la reprise des moniteurs** : désactivée par défaut.

Ouvrez ensuite l'onglet **Découverte** et créez les moniteurs à suivre.

## Déclencheurs de scène

- **Moniteur hors ligne** : UptimeRobot a confirmé un moniteur hors ligne
  (`down`) alors qu'il était en ligne à la lecture précédente.
- **Moniteur rétabli** : un moniteur confirmé hors ligne à la lecture
  précédente est de nouveau en ligne.

Les deux peuvent viser un moniteur précis (vide : tous) et donnent à la scène
le nom et le type du moniteur. Ils ne se déclenchent jamais :

- à la première lecture (démarrage, redémarrage, nouvelle configuration) ni
  pour un moniteur qui vient d'apparaître ;
- après un long trou : quand la lecture précédente date de plus de deux
  intervalles (plus une minute), le changement devient seulement la nouvelle
  référence ;
- sur « semble hors ligne » (`seems_down`) : UptimeRobot ne l'a pas encore
  confirmé ;
- après une pause ou une reprise.

La scène démarre jusqu'à un intervalle de rafraîchissement après le
changement.

## Pause et reprise

Par défaut Gladys ne fait que lire. Une fois **Autoriser la pause et la
reprise des moniteurs** cochée, chaque moniteur reçoit deux boutons, **Pause
monitoring** et **Resume monitoring** (cliquez sur **Mettre à jour** dans la
Découverte pour les ajouter à un appareil déjà créé). Ce ne sont jamais des
interrupteurs : ni assistant vocal ni « éteins tout » ne peut mettre vos
moniteurs en pause.

- Il faut la **clé principale** : UptimeRobot refuse la pause avec une clé en
  lecture seule, et Gladys le dit.
- Un moniteur en pause ne vous alerte plus.
- Décocher l'option prend effet tout de suite ; les boutons restent sur les
  appareils (pour ne jamais casser l'historique) mais sont refusés.
- Quand la commande ne peut pas partir en 3,5 s, rien n'est envoyé. Une
  commande partie sans réponse à temps (ou avec une erreur serveur) s'affiche
  en échec avec le message « The command was sent but UptimeRobot did not
  confirm it » (jamais « nothing was sent ») : la lecture suivante montre le
  résultat. Les messages des commandes sont en anglais, comme ceux du cœur.
- Un refus « trop de requêtes » (HTTP 429) s'affiche « UptimeRobot refused
  the command (HTTP 429, too many requests): not done » : la commande n'a pas
  été faite, et toutes les requêtes s'arrêtent pendant la pause indiquée.

## Limites d'usage et problèmes de connexion

- L'offre gratuite d'UptimeRobot admet **10 requêtes par minute**
  (documentation de l'API). Gladys en envoie **8 au plus** par minute, toutes
  requêtes comptées (lectures et boutons) : au-delà, un bouton est refusé sans
  rien envoyer (« Too many requests to UptimeRobot this minute »), et la
  lecture attend une minute (état « En attente du budget de requêtes de la
  minute », ou le message propre du bouton **Tester la connexion**).
- **Redémarrage** : après une lecture réussie, Gladys relit tout de suite,
  mais jamais moins d'une minute après la dernière requête (des redémarrages
  en boucle ne dépassent pas la limite). Après un échec, une pause ou un
  budget épuisé, l'attente prévue est gardée (au plus un intervalle) ; l'état
  l'indique (« Redémarré : … Lecture dans N min. »). **Tester la connexion**
  lit tout de suite.
- **API v2 retirée** (HTTP 404 ou 410) : l'état le dit (« elle a peut-être été
  retirée. Mettez à jour l'intégration. ») ; Gladys réessaie de plus en plus
  espacé.
- **Clé refusée** : Gladys ne réessaie pas seul, même après un redémarrage.
  Collez la clé et enregistrez, ou appuyez sur **Tester la connexion**.
- **UptimeRobot surchargé** (HTTP 429) ou **erreur serveur** (HTTP 5xx) :
  toutes les requêtes s'arrêtent, au moins l'intervalle choisi (429 : de 1
  minute à 6 heures, ce que demande UptimeRobot), même après un redémarrage ;
  enregistrer la configuration ou appuyer sur **Tester la connexion** lève la
  pause.
- **UptimeRobot injoignable** : nouvel essai à l'intervalle choisi, puis de
  plus en plus espacé jusqu'à une heure. Les appareils apparaissent
  injoignables entre-temps.

## Limites

- Un seul compte UptimeRobot par intégration, 200 moniteurs au plus (les
  moniteurs déjà créés passent d'abord ; l'état de la connexion dit combien
  sont écartés).
- Gladys accepte 300 états par minute : avec beaucoup de moniteurs, la
  première publication peut prendre quelques minutes.
- Les disponibilités en % n'ont pas d'unité dans Gladys (le cœur n'a pas de
  catégorie « disponibilité ») : 99.95 veut dire 99,95 %.
- Le temps de réponse n'est publié que s'il date de moins de 2 heures.
- Les pages de statut, les fenêtres de maintenance et les contacts d'alerte ne
  sont pas suivis.
