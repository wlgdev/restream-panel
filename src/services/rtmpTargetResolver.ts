export type ResolvedRtmpTarget = "VK" | "YOUTUBE" | "UNKNOWN";

interface IpInfoResponse {
  org?: string;
}

interface FetchLikeResponse {
  ok: boolean;
  json(): Promise<IpInfoResponse>;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<FetchLikeResponse>;

interface RtmpTargetResolverOptions {
  fetcher?: FetchLike;
  timeoutMs?: number;
}

export class RtmpTargetResolver {
  private static readonly MAX_CACHE_SIZE = 100;

  private readonly cache = new Map<string, ResolvedRtmpTarget>();
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;

  public constructor(options: RtmpTargetResolverOptions = {}) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  public async resolveTarget(ip: string): Promise<ResolvedRtmpTarget> {
    const normalizedIp = ip.trim();
    if (!normalizedIp) {
      return "UNKNOWN";
    }

    const cached = this.cache.get(normalizedIp);
    if (cached) {
      return cached;
    }

    if (this.cache.size > RtmpTargetResolver.MAX_CACHE_SIZE) {
      this.cache.clear();
    }

    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      const response = await Promise.race([
        this.fetcher(`https://ipinfo.io/${normalizedIp}/json`, {
          signal: abortController.signal,
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            abortController.abort();
            reject(new Error("RTMP target lookup timed out"));
          }, this.timeoutMs);
        }),
      ]);

      if (!response.ok) {
        return "UNKNOWN";
      }

      const payload = await response.json();
      const target = RtmpTargetResolver.targetFromOrg(payload?.org);
      this.cache.set(normalizedIp, target);
      return target;
    } catch {
      return "UNKNOWN";
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }
  }

  private static targetFromOrg(org?: string): ResolvedRtmpTarget {
    const value = org?.toLowerCase() ?? "";

    if (value.includes("google")) {
      return "YOUTUBE";
    }

    if (value.includes("vk")) {
      return "VK";
    }

    return "UNKNOWN";
  }
}
