// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, buttons, errors).
// Errors thrown to Gladys are English (one language per message, like the
// core's); the statuses and button answers are { en, fr }. No text ever
// quotes the API key nor an answer of the API (only the error `type`).
// -----------------------------------------------------------------------------

import { CODES } from './uptimerobot/errors.js';

const plural = (n, one, many) => (n === 1 ? one : many);
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

/** Why UptimeRobot failed, in a few words. */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
    case CODES.NO_TIME:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.API:
      return { en: `API error ${err.apiType}`, fr: `erreur de l’API ${err.apiType}` };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.CLOSED:
      return { en: 'configuration changed', fr: 'configuration changée' };
    case CODES.LIMITED:
      return {
        en: 'request budget of the minute spent',
        fr: 'budget de requêtes de la minute épuisé',
      };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

const RETRY = (delay) => ({
  en: `Retried in ${minutes(delay)} min.`,
  fr: `Nouvel essai dans ${minutes(delay)} min.`,
});

const join = (...parts) => ({
  en: parts
    .map((p) => p.en)
    .filter(Boolean)
    .join(' '),
  fr: parts
    .map((p) => p.fr)
    .filter(Boolean)
    .join(' '),
});

export const T = {
  status: {
    ok: ({ monitors, up, down, paused, missing, leftOut = 0 }) =>
      join(
        {
          en: `UptimeRobot answers: ${monitors} ${plural(monitors, 'monitor', 'monitors')} (${up} up, ${down} down, ${paused} paused).`,
          fr: `UptimeRobot répond : ${monitors} ${plural(monitors, 'moniteur', 'moniteurs')} (${up} en ligne, ${down} hors ligne, ${paused} en pause).`,
        },
        missing.length > 0
          ? {
              en: `Not found in the account: ${missing.join(', ')}.`,
              fr: `Introuvables dans le compte : ${missing.join(', ')}.`,
            }
          : {},
        leftOut > 0
          ? {
              en: `${leftOut} ${plural(leftOut, 'monitor', 'monitors')} left out (200 at most): pick the monitors to follow in the configuration.`,
              fr: `${leftOut} ${plural(leftOut, 'moniteur écarté', 'moniteurs écartés')} (200 au plus) : choisissez les moniteurs à suivre dans la configuration.`,
            }
          : {},
      ),
    noMonitor: {
      en: 'UptimeRobot answers, but no monitor matches: create one on uptimerobot.com, or check the monitor ids of the configuration (empty: every monitor).',
      fr: 'UptimeRobot répond, mais aucun moniteur ne correspond : créez-en un sur uptimerobot.com, ou vérifiez les identifiants de moniteurs de la configuration (vide : tous les moniteurs).',
    },
    missingKey: {
      en: 'Type an API key of your UptimeRobot account (Integrations & API, API): the read-only key is enough.',
      fr: 'Saisissez une clé d’API de votre compte UptimeRobot (Integrations & API, API) : la clé en lecture seule suffit.',
    },
    keyInvalid: {
      en: 'The API key holds a space or an invisible character (copied with it?): paste it again, only the key.',
      fr: 'La clé d’API contient une espace ou un caractère invisible (copié avec ?) : collez-la de nouveau, la clé seule.',
    },
    monitorsInvalid: (tokens) => ({
      en: `These are not UptimeRobot monitor ids (digits only, e.g. 777749809): ${tokens.join(', ')}.`,
      fr: `Ce ne sont pas des identifiants de moniteurs UptimeRobot (chiffres seulement, ex. 777749809) : ${tokens.join(', ')}.`,
    }),
    tooManyIds: {
      en: 'At most 50 monitor ids in the configuration: remove some, or leave it empty to follow every monitor.',
      fr: 'Au plus 50 identifiants de moniteurs dans la configuration : retirez-en, ou laissez vide pour suivre tous les moniteurs.',
    },
    keyRefused: {
      en: 'UptimeRobot refused the API key (wrong or deleted). Gladys does not try again by itself: copy a key from uptimerobot.com (Integrations & API, API), paste it and save, or press "Test the connection".',
      fr: 'UptimeRobot a refusé la clé d’API (fausse ou supprimée). Gladys ne réessaie pas seul : copiez une clé depuis uptimerobot.com (Integrations & API, API), collez-la et enregistrez, ou appuyez sur « Tester la connexion ».',
    },
    busy: (delay) =>
      join(
        {
          en: 'UptimeRobot asks Gladys to slow down (HTTP 429): every request is paused.',
          fr: 'UptimeRobot demande à Gladys de ralentir (HTTP 429) : toutes les requêtes sont suspendues.',
        },
        RETRY(delay),
      ),
    serverError: (status, delay) =>
      join(
        {
          en: `UptimeRobot answers with a server error (HTTP ${status}): every request is paused.`,
          fr: `UptimeRobot répond par une erreur serveur (HTTP ${status}) : toutes les requêtes sont suspendues.`,
        },
        RETRY(delay),
      ),
    unreachable: (err, delay) =>
      join(
        { en: 'UptimeRobot does not answer:', fr: 'UptimeRobot ne répond pas :' },
        reasonOf(err),
        { en: '—', fr: '—' },
        RETRY(delay),
      ),
  },
  test: {
    ok: ({ monitors }) => ({
      en: `Connected: ${monitors} ${plural(monitors, 'monitor', 'monitors')}.`,
      fr: `Connecté : ${monitors} ${plural(monitors, 'moniteur', 'moniteurs')}.`,
    }),
  },
  errors: {
    unknownDevice: 'Unknown device or feature: pick one of this integration',
    readOnly: 'This feature is a reading: use the Pause or Resume button of the monitor',
    invalidValue: 'Invalid value: press the button',
    notConnected: 'UptimeRobot is not connected: see the configuration of the integration',
    commandsDisabled:
      'Pause and resume are off: allow them first in the configuration of the integration ("Allow pausing and resuming monitors"). Nothing was sent',
    unknownMonitor:
      'This monitor is not followed (not read yet, or left out of the configuration): nothing was sent',
    busy: 'UptimeRobot asked Gladys to slow down: nothing was sent, try again later',
    limited:
      'Too many requests to UptimeRobot this minute (10 a minute on the free plan): nothing was sent, try again in a minute',
    tooSlow:
      'Gladys waits 5 s for the answer and there is no time left: nothing was sent, try again',
    configChanged: 'The configuration changed meanwhile: nothing was sent, try again',
    notSent: (err) =>
      `The command could not reach UptimeRobot (${reasonOf(err).en}): nothing was sent`,
    refusedKey:
      'UptimeRobot refused the command: a read-only or monitor-specific API key cannot pause nor resume (use the main API key)',
    refused: (err) => `UptimeRobot refused the command (${reasonOf(err).en})`,
    unconfirmed: (err) =>
      `The command was sent but UptimeRobot did not confirm it (${reasonOf(err).en}): the next reading shows the result`,
    testTooLong:
      'UptimeRobot has not answered yet: see the connection status in a moment (nothing else to do)',
  },
};
