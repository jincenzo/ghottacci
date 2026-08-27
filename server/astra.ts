import { parseDatexTraffic } from './datex.ts';
import type { TrafficResponse } from './types.ts';

const API_URL = 'https://api.opentransportdata.swiss/TDP/Soap_Datex2/TrafficSituations/Pull';
const SOAP_ACTION = 'http://opentransportdata.swiss/TDP/Soap_Datex2/Pull/v1/pullTrafficMessages';
const REQUEST_TIMEOUT_MS = 20_000;

export class AstraHttpError extends Error {
  constructor(public readonly status: number) {
    super(`ASTRA returned HTTP ${status}`);
    this.name = 'AstraHttpError';
  }
}

function soapBody(startedAt: Date): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <d2LogicalModel xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" modelBaseVersion="2" xmlns="http://datex2.eu/schema/2/2_0">
      <exchange>
        <supplierIdentification>
          <country>ch</country>
          <nationalIdentifier>FEDRO</nationalIdentifier>
        </supplierIdentification>
        <subscription>
          <operatingMode>operatingMode1</operatingMode>
          <subscriptionStartTime>${startedAt.toISOString()}</subscriptionStartTime>
          <subscriptionState>active</subscriptionState>
          <updateMethod>singleElementUpdate</updateMethod>
          <target><address></address><protocol>http</protocol></target>
        </subscription>
      </exchange>
    </d2LogicalModel>
  </soap:Body>
</soap:Envelope>`;
}

function bearerValue(apiKey: string): string {
  return apiKey.trim().replace(/^Bearer\s+/i, '');
}

export async function fetchAstraTraffic(apiKey: string): Promise<TrafficResponse> {
  const requestedAt = new Date();
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerValue(apiKey)}`,
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: SOAP_ACTION,
      Accept: 'application/xml, text/xml',
    },
    body: soapBody(requestedAt),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const xml = await response.text();
  if (!response.ok) {
    throw new AstraHttpError(response.status);
  }
  if (!xml.trim()) throw new Error('ASTRA returned an empty response');
  if (/<(?:\w+:)?Fault\b/i.test(xml)) throw new Error('ASTRA returned a SOAP fault');

  try {
    return parseDatexTraffic(xml, requestedAt);
  } catch (error) {
    throw new Error('ASTRA returned unreadable DATEX II XML', { cause: error });
  }
}
