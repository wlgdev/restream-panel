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
