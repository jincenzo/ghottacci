import { describe, expect, it } from 'vitest';
import { parseDatexTraffic } from './datex.ts';

const envelope = (records: string) => `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:d2="http://datex2.eu/schema/2/2_0">
  <soap:Body><d2:d2LogicalModel><d2:payloadPublication>
    <d2:publicationTime>2026-08-27T12:00:00Z</d2:publicationTime>
    <d2:situation>${records}</d2:situation>
  </d2:payloadPublication></d2:d2LogicalModel></soap:Body>
</soap:Envelope>`;

describe('parseDatexTraffic', () => {
  it('extracts multilingual Gotthard queues and directions', () => {
    const xml = envelope(`
      <d2:situationRecord>
        <d2:situationRecordVersionTime>2026-08-27T11:58:00Z</d2:situationRecordVersionTime>
        <d2:generalPublicComment><d2:comment><d2:values>
          <d2:value lang="de-CH">A2 Gotthard Richtung Chiasso, zwischen Göschenen und Gotthard-Tunnel 7 km Stau, Zeitverlust 1 Std. 10 Minuten</d2:value>
        </d2:values></d2:comment></d2:generalPublicComment>
      </d2:situationRecord>
      <d2:situationRecord>
        <d2:generalPublicComment><d2:comment><d2:values>
          <d2:value lang="it-CH">A2 Airolo direzione Basilea: coda di 2,5 km, tempo d'attesa 25 minuti</d2:value>
        </d2:values></d2:comment></d2:generalPublicComment>
      </d2:situationRecord>`);

    const result = parseDatexTraffic(xml);
    expect(result.southbound).toMatchObject({ queueKm: 7, waitingMinutes: 70 });
    expect(result.southbound.details?.officialMessage).toContain('Göschenen');
    expect(result.northbound).toMatchObject({ queueKm: 2.5, waitingMinutes: 25 });
    expect(result.northbound.details?.officialMessage).toContain('Airolo');
    expect(result.updatedAt).toBe('2026-08-27T12:00:00.000Z');
  });

  it('uses structured lengths and ignores revoked records', () => {
    const xml = envelope(`
      <d2:situationRecord>
        <d2:generalPublicComment><d2:comment><d2:values><d2:value>A2 Göschenen Richtung Italien: Stau</d2:value></d2:values></d2:comment></d2:generalPublicComment>
        <d2:abnormalTrafficType>queuingTraffic</d2:abnormalTrafficType>
        <d2:cause><d2:causeType>congestion</d2:causeType></d2:cause>
        <d2:validity><d2:validityTimeSpecification><d2:overallStartTime>2026-08-27T10:00:00Z</d2:overallStartTime><d2:overallEndTime>2026-08-27T14:00:00Z</d2:overallEndTime></d2:validityTimeSpecification></d2:validity>
        <d2:impact><d2:numberOfLanesRestricted>1</d2:numberOfLanesRestricted></d2:impact>
        <d2:queueLength unit="metre">4200</d2:queueLength>
        <d2:delayTimeValue xsi:type="d2:Seconds" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">3000</d2:delayTimeValue>
      </d2:situationRecord>
      <d2:situationRecord>
        <d2:generalPublicComment><d2:comment><d2:values><d2:value>Aufgehoben: A2 Airolo Richtung Basel, 9 km Stau</d2:value></d2:values></d2:comment></d2:generalPublicComment>
        <d2:management><d2:lifeCycleManagement><d2:cancel>true</d2:cancel></d2:lifeCycleManagement></d2:management>
      </d2:situationRecord>`);

    const result = parseDatexTraffic(xml);
    expect(result.southbound).toMatchObject({
      queueKm: 4.2,
      waitingMinutes: 50,
      details: {
        eventType: 'Queuing traffic',
        cause: 'Congestion',
        validFrom: '2026-08-27T10:00:00Z',
        validUntil: '2026-08-27T14:00:00Z',
        untilFurtherNotice: false,
        lanesRestricted: 1,
      },
    });
    expect(result.northbound).toEqual({ queueKm: 0, waitingMinutes: null, details: null });
  });
});
