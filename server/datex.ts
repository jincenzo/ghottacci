import { XMLParser } from 'fast-xml-parser';
import type { DirectionTraffic, TrafficDetails, TrafficResponse } from './types.ts';

type XmlNode = Record<string, unknown>;
type Direction = 'southbound' | 'northbound';

type ParsedEvent = {
  direction: Direction;
  queueKm: number;
  waitingMinutes: number | null;
  updatedAt: string | null;
  details: TrafficDetails;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

const GOTTHARD_TERMS = /gotthard|gottardo|gothard|göschenen|goeschenen|airolo/i;
const A2_TERM = /(?:^|\W)a\s*2(?:\W|$)/i;
const QUEUE_WORD = /stau|queue|traffic jam|congestion|coda|colonna|bouchon|ral[l]?entamento/i;
const REVOKED_WORD = /aufgehoben|revoked|révoqué|revocato/i;

const SOUTH_DIRECTION = [
  /(?:richtung|fahrtrichtung|towards?|direction|direzione|verso)\s+(?:chiasso|lugano|ital(?:y|ia|ien)|s(?:ü|u)d)/i,
  /(?:chiasso|lugano|ital(?:y|ia|ien))\s+(?:bound|wärts)/i,
];

const NORTH_DIRECTION = [
  /(?:richtung|fahrtrichtung|towards?|direction|direzione|verso)\s+(?:basel|luzern|zürich|zurich|german(?:y)?|deutschland|nord|north)/i,
  /(?:basel|luzern|zürich|zurich|german(?:y)?|deutschland)\s+(?:bound|wärts)/i,
];

function localName(key: string): string {
  return key.split(':').at(-1)?.toLowerCase() ?? key.toLowerCase();
}

function collectByName(value: unknown, wanted: string, result: unknown[] = []): unknown[] {
  if (!value || typeof value !== 'object') return result;

  if (Array.isArray(value)) {
    value.forEach((item) => collectByName(item, wanted, result));
    return result;
  }

  Object.entries(value as XmlNode).forEach(([key, child]) => {
    if (localName(key) === wanted.toLowerCase()) {
      if (Array.isArray(child)) result.push(...child);
      else result.push(child);
    }
    collectByName(child, wanted, result);
  });
  return result;
}

function scalarText(value: unknown, result: string[] = []): string[] {
  if (typeof value === 'string' || typeof value === 'number') {
    result.push(String(value));
  } else if (Array.isArray(value)) {
    value.forEach((item) => scalarText(item, result));
  } else if (value && typeof value === 'object') {
    Object.entries(value as XmlNode)
      .filter(([key]) => !key.startsWith('@_'))
      .forEach(([, child]) => scalarText(child, result));
  }
  return result;
}

function firstText(record: unknown, names: string[]): string | null {
  for (const name of names) {
    const match = collectByName(record, name).flatMap((value) => scalarText(value))[0];
    if (match) return match;
  }
  return null;
}

function numericValue(value: unknown): number | null {
  const text = scalarText(value)[0];
  if (!text) return null;
  const parsed = Number(text.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function humanize(value: string | null): string | null {
  if (!value) return null;
  const words = value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : null;
}

function preferredPublicMessage(record: unknown): string | null {
  const comments = collectByName(record, 'generalPublicComment');
  const description = comments.find((comment) =>
    firstText(comment, ['commentType'])?.toLowerCase() === 'description',
  ) ?? comments[0];
  if (!description) return null;

  const values = collectByName(description, 'value')
    .map((node) => ({
      node,
      text: scalarText(node)[0] ?? '',
      language: node && typeof node === 'object'
        ? String((node as XmlNode)['@_lang'] ?? '').toLowerCase()
        : '',
    }))
    .filter((item) => item.text);

  const languagePriority = ['en', 'de', 'it', 'fr'];
  values.sort((a, b) => {
    const aIndex = languagePriority.findIndex((language) => a.language.startsWith(language));
    const bIndex = languagePriority.findIndex((language) => b.language.startsWith(language));
    return (aIndex < 0 ? 99 : aIndex) - (bIndex < 0 ? 99 : bIndex);
  });
  return values[0]?.text ?? null;
}

function causeFromMessage(message: string | null): string | null {
  if (!message) return null;
  const match = message.match(
    /(?:Ursache|Raison|Causa|Cause):\s*(.+?)(?=\s+(?:Verkehrsführung|Sachlage|Situation|Gestion du trafic|Limitazione del traffico|Zusatz|Complément|Aggiunta|Dauer|Durée|Durata|Empfehlung|Recommandation|Raccomandazione):|$)/i,
  );
  return match?.[1]?.trim() || null;
}

function detailsFor(record: unknown): TrafficDetails {
  const officialMessage = preferredPublicMessage(record);
  const untilFurtherNotice = collectByName(record, 'value').some((value) =>
    scalarText(value).some((text) => text.toLowerCase() === 'untilfurthernotice'),
  );
  const lanesRestrictedNode = collectByName(record, 'numberOfLanesRestricted')[0];

  return {
    eventType: humanize(firstText(record, [
      'abnormalTrafficType',
      'roadOrCarriagewayOrLaneManagementType',
      'roadworksType',
      'disturbanceActivityType',
    ])),
    cause: humanize(firstText(record, ['causeType'])) ?? causeFromMessage(officialMessage),
    validFrom: firstText(record, ['overallStartTime', 'startOfPeriod']),
    validUntil: untilFurtherNotice ? null : firstText(record, ['overallEndTime', 'endOfPeriod']),
    untilFurtherNotice,
    lanesRestricted: lanesRestrictedNode === undefined ? null : numericValue(lanesRestrictedNode),
    officialMessage,
  };
}

function structuredQueueKm(record: unknown): number | null {
  const queueNodes = [
    ...collectByName(record, 'queueLength'),
    ...collectByName(record, 'lengthOfTrafficQueue'),
  ];

  for (const node of queueNodes) {
    const value = numericValue(node);
    if (value === null) continue;
    const attributes = node && typeof node === 'object' ? (node as XmlNode) : {};
    const unit = String(attributes['@_unit'] ?? attributes['@_unitOfMeasure'] ?? '').toLowerCase();
    return unit.includes('kilo') || unit === 'km' ? value : value / 1000;
  }
  return null;
}

function textQueueKm(text: string): number | null {
  const patterns = [
    new RegExp(`(?:${QUEUE_WORD.source})[^.;\\n]{0,45}?(\\d+(?:[.,]\\d+)?)\\s*(?:km|kilomet(?:er|re|ri))`, 'i'),
    new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(?:km|kilomet(?:er|re|ri))[^.;\\n]{0,25}?(?:${QUEUE_WORD.source})`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1].replace(',', '.'));
  }
  return null;
}

function structuredWaitingMinutes(record: unknown): number | null {
  const minuteNodes = [
    ...collectByName(record, 'delayTimeValue'),
    ...collectByName(record, 'minimumDelay'),
    ...collectByName(record, 'maximumDelay'),
  ];
  for (const node of minuteNodes) {
    const value = numericValue(node);
    if (value === null) continue;
    const attributes = node && typeof node === 'object' ? (node as XmlNode) : {};
    const unit = String(attributes['@_unit'] ?? attributes['@_unitOfMeasure'] ?? attributes['@_type'] ?? '').toLowerCase();
    if (unit.includes('second')) return Math.round(value / 60);
    if (unit.includes('hour')) return Math.round(value * 60);
    // DATEX II delay values use Seconds when the unit is only expressed by the schema type.
    return unit ? Math.round(value) : Math.round(value / 60);
  }
  return null;
}

function textWaitingMinutes(text: string): number | null {
  const marker = /zeitverlust|wartezeit|waiting(?: time)?|delay|temps d.attente|retard|tempo d.attesa|attesa/i;
  const markerMatch = marker.exec(text);
  if (!markerMatch) return null;

  const nearby = text.slice(markerMatch.index + markerMatch[0].length, markerMatch.index + markerMatch[0].length + 70);
  const hoursMatch = nearby.match(/(\d+(?:[.,]\d+)?)\s*(?:h(?:ours?|r)?|std\.?|stunden?)/i);
  const minutesMatch = nearby.match(/(\d+(?:[.,]\d+)?)\s*(?:min(?:utes?|uti)?|minuten?)/i);
  if (!hoursMatch && !minutesMatch) return null;
  const hours = hoursMatch ? Number(hoursMatch[1].replace(',', '.')) : 0;
  const minutes = minutesMatch ? Number(minutesMatch[1].replace(',', '.')) : 0;
  return Math.round(hours * 60 + minutes);
}

function directionFromText(text: string): Direction | null {
  if (SOUTH_DIRECTION.some((pattern) => pattern.test(text))) return 'southbound';
  if (NORTH_DIRECTION.some((pattern) => pattern.test(text))) return 'northbound';

  // At this tunnel, queues reported at the north portal (Göschenen) travel south;
  // queues at the south portal (Airolo) travel north.
  const hasGoeschenen = /göschenen|goeschenen/i.test(text);
  const hasAirolo = /airolo/i.test(text);
  if (hasGoeschenen && !hasAirolo) return 'southbound';
  if (hasAirolo && !hasGoeschenen) return 'northbound';
  return null;
}

function isCancelled(record: unknown, text: string): boolean {
  const cancelled = collectByName(record, 'cancel').some((value) =>
    scalarText(value).some((item) => item.toLowerCase() === 'true'),
  );
  return cancelled || REVOKED_WORD.test(text);
}

function parseRecord(record: unknown): ParsedEvent | null {
  const text = scalarText(record).join(' ');
  if (!GOTTHARD_TERMS.test(text) || !A2_TERM.test(text) || isCancelled(record, text)) return null;

  const direction = directionFromText(text);
  if (!direction) return null;

  const queueKm = structuredQueueKm(record) ?? textQueueKm(text) ?? (QUEUE_WORD.test(text) ? 0.1 : 0);
  const waitingMinutes = structuredWaitingMinutes(record) ?? textWaitingMinutes(text);
  const updatedAt = firstText(record, ['situationRecordVersionTime', 'situationRecordCreationTime']);

  return { direction, queueKm, waitingMinutes, updatedAt, details: detailsFor(record) };
}

function emptyDirection(): DirectionTraffic {
  return { queueKm: 0, waitingMinutes: null, details: null };
}

export function parseDatexTraffic(xml: string, now = new Date()): TrafficResponse {
  const document = parser.parse(xml);
  const records = collectByName(document, 'situationRecord');
  const events = records.map(parseRecord).filter((event): event is ParsedEvent => event !== null);
  const result: TrafficResponse = {
    southbound: emptyDirection(),
    northbound: emptyDirection(),
    updatedAt: now.toISOString(),
  };

  for (const event of events) {
    const current = result[event.direction];
    const shouldUseDetails = current.details === null
      || event.queueKm > current.queueKm
      || (event.queueKm === current.queueKm && (event.waitingMinutes ?? 0) > (current.waitingMinutes ?? 0));
    if (shouldUseDetails) current.details = event.details;
    current.queueKm = Math.max(current.queueKm, event.queueKm);
    if (event.waitingMinutes !== null) {
      current.waitingMinutes = Math.max(current.waitingMinutes ?? 0, event.waitingMinutes);
    }
  }

  const feedTime = firstText(document, ['publicationTime']);
  const eventTimes = events.flatMap((event) => (event.updatedAt ? [event.updatedAt] : []));
  const validTimes = [feedTime, ...eventTimes]
    .filter((value): value is string => Boolean(value) && !Number.isNaN(Date.parse(value!)))
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  if (validTimes[0]) result.updatedAt = new Date(validTimes[0]).toISOString();

  result.southbound.queueKm = Number(result.southbound.queueKm.toFixed(1));
  result.northbound.queueKm = Number(result.northbound.queueKm.toFixed(1));
  return result;
}
