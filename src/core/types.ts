export interface TargetServer {
  id: string;
  name: string;
  url: string;
  requiresStreamKey: boolean;
  supportsDynamicStreamKey?: boolean;
}

export interface PushTarget {
  server: TargetServer;
  streamKey: string;
}

export interface Application {
  name: string;
  isProtected: boolean;
  pushTargets: PushTarget[];
}

export interface StreamTargetConfig {
  id: string;
}

export interface NginxConfig {
  applications: Application[];
  streamTargets: StreamTargetConfig[];
  headerContent: string;
  footerContent: string;
  stunnelComments: string;
}

export interface ApplicationData {
  name: string;
  pushTargets: {
    serverId: string;
    streamKey: string;
  }[];
}

export interface ParseResult {
  success: boolean;
  config?: NginxConfig;
  error?: string;
}

export interface WriteResult {
  success: boolean;
  content?: string;
  error?: string;
}

export interface OperationResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

// Codec properties of a mediamtx path track (from GET /v3/paths/list -> items[].tracks2[]).
// Video tracks carry width/height/profile/level; audio tracks carry sampleRate/channelCount.
// All inner fields are optional — mediamtx emits an empty codecProps object for some codecs.
export interface TrackCodecProps {
  width?: number;
  height?: number;
  profile?: string;
  level?: string;
  sampleRate?: number;
  channelCount?: number;
}

export interface Track {
  codec: string;
  codecProps?: TrackCodecProps;
}
