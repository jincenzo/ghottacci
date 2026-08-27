export type TrafficDetails = {
  eventType: string | null;
  cause: string | null;
  validFrom: string | null;
  validUntil: string | null;
  untilFurtherNotice: boolean;
  lanesRestricted: number | null;
  officialMessage: string | null;
};

export type DirectionTraffic = {
  queueKm: number;
  waitingMinutes: number | null;
  details: TrafficDetails | null;
};

export type TrafficData = {
  southbound: DirectionTraffic;
  northbound: DirectionTraffic;
  updatedAt: string;
};

export type TrafficError = {
  error: string;
  code?: 'api_key_required' | 'invalid_api_key';
  staleData?: TrafficData;
};
