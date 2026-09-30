/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

'use client';

import Artplayer from 'artplayer';
import Hls from 'hls.js';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import {
  deletePlayRecord,
  deletePlaybackRateConfig,
  deleteSkipConfig,
  generateStorageKey,
  getAllPlayRecords,
  getPlaybackRateConfig,
  getSkipConfig,
  savePlaybackRateConfig,
  savePlayRecord,
  saveSkipConfig,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { SearchResult } from '@/lib/types';
import { getVideoResolutionFromM3u8, processImageUrl } from '@/lib/utils';

import EpisodeSelector from '@/components/EpisodeSelector';
import PageLayout from '@/components/PageLayout';

// 扩展 HTMLVideoElement 类型以支持 hls 属性
declare global {
  interface HTMLVideoElement {
    hls?: any;
  }
}

// Wake Lock API 类型声明
interface WakeLockSentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
}

interface PlaybackRateSelector {
  name: string;
  value: number;
  html: string;
}

// -----------------------------------------------------------------------------
// 播放速率（倍速）相关常量
// 说明：定义在模块级，保证跨渲染引用稳定，供播放器事件回调安全使用
// -----------------------------------------------------------------------------
/** 可选播放速率 */
const PLAYBACK_RATE_OPTIONS = [2.0, 1.5, 1.25, 1.0, 0.75, 0.5];
/** 允许区间（容错：数据库里可能存了非预设的合法值） */
const PLAYBACK_RATE_MIN = 0.25;
const PLAYBACK_RATE_MAX = 4;
/** 长按画面加速的倍率（主流播放器惯例） */
const LONG_PRESS_RATE = 3;
/** 长按判定时间（毫秒），超过该时长视为长按加速 */
const LONG_PRESS_DELAY = 400;

/** 速率文案：1 倍速时显示「倍速」，其余显示具体数字（如 1.5x） */
function formatPlaybackRateText(rate: number): string {
  return Math.abs(rate - 1) < 0.001 ? '倍速' : `${rate}x`;
}

/** 速率是否合法（预设值优先，同时容忍区间内的其他值） */
function isValidPlaybackRate(rate: unknown): rate is number {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return false;
  if (PLAYBACK_RATE_OPTIONS.includes(rate)) return true;
  return rate >= PLAYBACK_RATE_MIN && rate <= PLAYBACK_RATE_MAX;
}

function PlayPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // -----------------------------------------------------------------------------
  // 状态变量（State）
  // -----------------------------------------------------------------------------
  const [Artplayer, setArtplayer] = useState<any>(null);
  const [Hls, setHls] = useState<any>(null);

  useEffect(() => {
    import('artplayer').then((art) => setArtplayer(() => art.default));
    import('hls.js').then((hls) => setHls(() => hls.default));
  }, []);
  const [loading, setLoading] = useState(true);
  const [loadingStage, setLoadingStage] = useState<'searching' | 'preferring' | 'fetching' | 'ready'>('searching');
  const [loadingMessage, setLoadingMessage] = useState('正在获取影片信息');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SearchResult | null>(null);

  

  // 跳过片头片尾配置
  const [skipConfig, setSkipConfig] = useState({
    enable: false,
    intro_time: 0,
    outro_time: 0,
  });
  const skipConfigRef = useRef(skipConfig);
  useEffect(() => {
    skipConfigRef.current = skipConfig;
  }, [
    skipConfig,
    skipConfig.enable,
    skipConfig.intro_time,
    skipConfig.outro_time,
  ]);

  // 跳过检查的时间间隔控制
  const lastSkipCheckRef = useRef(0);

  // 拦截广告开关（从 localStorage 继承，默认 true）
  const [blockAdEnabled, setBlockAdEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('enable_blockad');
      if (v !== null) return v === 'true';
    }
    return true;
  });
  const blockAdEnabledRef = useRef(blockAdEnabled);
  useEffect(() => {
    blockAdEnabledRef.current = blockAdEnabled;
  }, [blockAdEnabled]);

  // 视频基本信息
  const [videoTitle, setVideoTitle] = useState(searchParams.get('title') || '');
  const [videoYear, setVideoYear] = useState(searchParams.get('year') || '');
  const [videoCover, setVideoCover] = useState('');
  const [videoDoubanId, setVideoDoubanId] = useState(0);
  // 当前源和ID
  const [currentSource, setCurrentSource] = useState(
    searchParams.get('source') || ''
  );
  const [currentId, setCurrentId] = useState(searchParams.get('id') || '');

  // 搜索所需信息
  const [searchTitle] = useState(searchParams.get('stitle') || '');
  const [searchType] = useState(searchParams.get('stype') || '');

  // 是否需要优选
  const [needPrefer, setNeedPrefer] = useState(
    searchParams.get('prefer') === 'true'
  );
  const needPreferRef = useRef(needPrefer);
  useEffect(() => {
    needPreferRef.current = needPrefer;
  }, [needPrefer]);
  // 集数相关
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(0);

  const currentSourceRef = useRef(currentSource);
  const currentIdRef = useRef(currentId);
  const videoTitleRef = useRef(videoTitle);
  const videoYearRef = useRef(videoYear);
  const detailRef = useRef<SearchResult | null>(detail);
  const currentEpisodeIndexRef = useRef(currentEpisodeIndex);

  // 同步最新值到 refs
  useEffect(() => {
    currentSourceRef.current = currentSource;
    currentIdRef.current = currentId;
    detailRef.current = detail;
    currentEpisodeIndexRef.current = currentEpisodeIndex;
    videoTitleRef.current = videoTitle;
    videoYearRef.current = videoYear;
  }, [
    currentSource,
    currentId,
    detail,
    currentEpisodeIndex,
    videoTitle,
    videoYear,
  ]);

  // 视频播放地址
  const [videoUrl, setVideoUrl] = useState('');

  // 总集数
  const totalEpisodes = detail?.episodes?.length || 0;

  // 用于记录是否需要在播放器 ready 后跳转到指定进度
  const resumeTimeRef = useRef<number | null>(null);
  // 上次使用的音量，默认 1.0
  const lastVolumeRef = useRef<number>(1.0);
  // 用户设定的播放速率（倍速），默认 1.0
  const playbackRateRef = useRef<number>(1.0);
  // 长按画面 3 倍速播放相关
  const [isLongPressRacing, setIsLongPressRacing] = useState(false);
  const longPressRateActiveRef = useRef(false);
  const longPressRateTimerRef = useRef<NodeJS.Timeout | null>(null);
  const suppressVideoClickRef = useRef(false);

  // 路线相关状态
  const [availableSources, setAvailableSources] = useState<SearchResult[]>([]);
  const [sourceSearchLoading, setSourceSearchLoading] = useState(false);
  const [sourceSearchError, setSourceSearchError] = useState<string | null>(
    null
  );

  // 优选和测速开关
  const [optimizationEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('enableOptimization');
      if (saved !== null) {
        try {
          return JSON.parse(saved);
        } catch {
          /* ignore */
        }
      }
    }
    return true;
  });

  // 保存优选时的测速结果，避免EpisodeSelector重复测速
  const [precomputedVideoInfo, setPrecomputedVideoInfo] = useState<Map<string, { quality: string; loadSpeed: string; pingTime: number }>>(new Map());

  
  

  // 路线加载状态
  const [isVideoLoading, setIsVideoLoading] = useState(true);
  const [videoLoadingStage, setVideoLoadingStage] = useState<
    'initing' | 'sourceChanging'
  >('initing');

  // 播放进度保存相关
  const saveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastSaveTimeRef = useRef<number>(0);

  const artPlayerRef = useRef<any>(null);
  const artRef = useRef<HTMLDivElement | null>(null);

  // Wake Lock 相关
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // 长按显示的剧集标题
  const [longPressedTitle, setLongPressedTitle] = useState<string | null>(null);
  const [isFadingOut, setIsFadingOut] = useState(false); // 新增状态，控制淡出动画
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const fadeOutTimerRef = useRef<NodeJS.Timeout | null>(null); // 新增ref，用于管理淡出计时器

  // -----------------------------------------------------------------------------
  // 工具函数（Utils）
  // -----------------------------------------------------------------------------

  // 播放源优选函数
  const preferBestSource = async (
    sources: SearchResult[]
  ): Promise<SearchResult> => {
    if (sources.length === 1) return sources[0];

    // 第一阶段：快速Ping测试
    console.log('开始第一阶段：快速Ping测试');
    const PING_THRESHOLD = 800; // 800毫秒
    const pingPromises = sources.map(source => {
        const episodeUrl = source.episodes?.[0];
        if (!episodeUrl) return Promise.resolve({ source, ping: Infinity });
        const start = performance.now();
        // 使用HEAD请求以获得更准确的ping时间
        return fetch(episodeUrl, { method: 'HEAD', mode: 'no-cors' })
            .then(() => ({ source, ping: performance.now() - start }))
            .catch(() => ({ source, ping: performance.now() - start })); // 如果HEAD请求失败（例如CORS），则回退到计时
    });

    const pingResults = await Promise.all(pingPromises);
    const survivingSources = pingResults
        .filter(result => result.ping < PING_THRESHOLD)
        .sort((a, b) => a.ping - b.ping)
        .map(result => result.source);

    console.log(`第一阶段完成: ${survivingSources.length} / ${sources.length} 个源通过Ping测试.`);

    if (survivingSources.length === 0) {
        console.warn('没有源通过Ping测试，将使用第一个原始源作为备用。');
        return sources[0];
    }
    if (survivingSources.length === 1) {
        return survivingSources[0];
    }

    // 第二阶段：对通过的源进行完整测试
    const allResults: Array<{ source: SearchResult; testResult: { quality: string; loadSpeed: string; pingTime: number; speedJitter: number; } } | null> = [];

    const testSource = async (source: SearchResult) => {
      try {
        if (!source.episodes || source.episodes.length === 0) {
          console.warn(`播放源 ${source.source_name} 没有可用的播放地址`);
          return null;
        }
        const episodeUrl =
          source.episodes.length > 1
            ? source.episodes[1] // 如果可能，使用靠后的集数进行测试
            : source.episodes[0];
        const testResult = await getVideoResolutionFromM3u8(episodeUrl);
        return { source, testResult };
      } catch (error) {
        return null;
      }
    };

      // 并行测速逻辑
      console.log('开始第二阶段：完整测速（并行分批）');
      const batchSize = Math.ceil(survivingSources.length / 2);
      for (let start = 0; start < survivingSources.length; start += batchSize) {
          const batchSources = survivingSources.slice(start, start + batchSize);
          const batchResults = await Promise.all(batchSources.map(testSource));
          allResults.push(...batchResults);
      }

    const newVideoInfoMap = new Map<string, any>();
    allResults.forEach((result) => {
      if (result) {
        const sourceKey = `${result.source.source}-${result.source.id}`;
        newVideoInfoMap.set(sourceKey, result.testResult);
      }
    });

    const successfulResults = allResults.filter(Boolean) as Array<{ source: SearchResult; testResult: { quality: string; loadSpeed: string; pingTime: number; speedJitter: number; } }>;

    setPrecomputedVideoInfo(newVideoInfoMap);

    if (successfulResults.length === 0) {
      console.warn('所有幸存的播放源测速都失败，使用第一个幸存源');
      return survivingSources[0];
    }

    const validSpeeds = successfulResults
      .map((result) => {
        const speedStr = result.testResult.loadSpeed;
        if (speedStr === '未知' || speedStr === '测量中...') return 0;
        const match = speedStr.match(/^([\d.]+)\s*(KB\/s|MB\/s)$/);
        if (!match) return 0;
        const value = parseFloat(match[1]);
        return match[2] === 'MB/s' ? value * 1024 : value;
      })
      .filter((speed) => speed > 0);

    const maxSpeed = validSpeeds.length > 0 ? Math.max(...validSpeeds) : 1024;

    const validPings = successfulResults.map(r => r.testResult.pingTime).filter(p => p > 0);
    const minPing = validPings.length > 0 ? Math.min(...validPings) : 50;
    const maxPing = validPings.length > 0 ? Math.max(...validPings) : 1000;

    const validJitters = successfulResults.map(r => r.testResult.speedJitter).filter(j => j > 0);
    const maxJitter = validJitters.length > 0 ? Math.max(...validJitters) : 500;

    const resultsWithScore = successfulResults.map((result) => ({
      ...result,
      score: calculateSourceScore(
        result.testResult,
        maxSpeed,
        minPing,
        maxPing,
        maxJitter
      ),
    }));

    resultsWithScore.sort((a, b) => b.score - a.score);

    console.log('播放源评分排序结果:');
    resultsWithScore.forEach((result, index) => {
      console.log(
        `${index + 1}. ${result.source.source_name} - 评分: ${result.score.toFixed(2)} (画质: ${result.testResult.quality}, 速度: ${result.testResult.loadSpeed}, 延迟: ${result.testResult.pingTime}ms, 抖动: ${result.testResult.speedJitter.toFixed(2)}KB/s)`
      );
    });

    return resultsWithScore[0].source;
  };

  // 计算播放源综合评分
  const calculateSourceScore = (
    testResult: {
      quality: string;
      loadSpeed: string;
      pingTime: number;
      speedJitter: number;
    },
    maxSpeed: number,
    minPing: number,
    maxPing: number,
    maxJitter: number
  ): number => {
    let score = 0;

    // --- 1. 分辨率评分 (权重: 30%) ---
    let qualityScore = (() => {
      switch (testResult.quality) {
        case '4K': return 100;
        case '2K': return 90;
        case '1080P': return 75;
        case '720P': return 50;
        case '480P': return 25;
        case 'SD': return 10;
        default: return 0;
      }
    })();

    // --- 关联性判断: 速度是否支撑画质 ---
    const requiredSpeed: { [quality: string]: number } = { // 单位 KB/s
        '4K': 2500,    // 20 Mbps
        '2K': 1875,    // 15 Mbps
        '1080P': 1000, // 8 Mbps
        '720P': 500,   // 4 Mbps
    };
    const speedStr = testResult.loadSpeed;
    const match = speedStr.match(/^([\d.]+)\s*(KB\/s|MB\/s)$/);
    let speedKBps = 0;
    if (match) {
        const value = parseFloat(match[1]);
        speedKBps = match[2] === 'MB/s' ? value * 1024 : value;
    }

    const required = requiredSpeed[testResult.quality];
    if (required && speedKBps > 0 && speedKBps < required) {
        // 如果速度不足以支撑画质，画质分大打折扣
        qualityScore *= 0.3; // 仅获得30%的画质分
        console.log(`  - ${testResult.quality}速度不足(${speedKBps.toFixed(0)}KB/s < ${required}KB/s)，画质分被惩罚.`);
    }
    score += qualityScore * 0.30;

    // --- 2. 下载速度评分 (权重: 40%) ---
    const speedScore = (() => {
      if (speedKBps === 0) return 30; // 未知速度给一个基础分
      // S型曲线评分，在达到2.5MB/s后增长放缓
      const k = 0.0015;
      const x0 = 2500; // 2.5 MB/s
      return 100 / (1 + Math.exp(-k * (speedKBps - x0)));
    })();
    score += speedScore * 0.40;

    // --- 3. 网络延迟评分 (权重: 10%) ---
    const pingScore = (() => {
      const ping = testResult.pingTime;
      if (ping <= 0) return 0;
      if (maxPing === minPing) return 100;
      const pingRatio = (maxPing - ping) / (maxPing - minPing);
      return Math.min(100, Math.max(0, pingRatio * 100));
    })();
    score += pingScore * 0.10;

    // --- 4. 稳定性评分 (权重: 20%) ---
    const jitterScore = (() => {
        if (testResult.speedJitter <= 0 || maxJitter <= 0) return 100; // 没有抖动或无法计算则为满分
        // 抖动越小越好，线性反向评分
        const jitterRatio = testResult.speedJitter / maxJitter;
        return 100 * (1 - Math.min(1, jitterRatio));
    })();
    score += jitterScore * 0.20;

    // --- 惩罚机制: 平滑延迟惩罚 ---
    const pingPenalty = (() => {
        const ping = testResult.pingTime;
        const goodPing = 150; // 150毫秒
        const badPing = 600; // 600毫秒
        if (ping <= goodPing) return 1.0; // 无惩罚
        if (ping >= badPing) return 0.7; // 最大惩罚 (30%)
        // 在[150, 600]区间内线性惩罚
        const penaltyFactor = (ping - goodPing) / (badPing - goodPing);
        return 1.0 - (penaltyFactor * 0.3);
    })();
    if (pingPenalty < 1.0) {
        console.log(`  - 延迟(${testResult.pingTime}ms)触发平滑惩罚，分数乘以${pingPenalty.toFixed(2)}`);
        score *= pingPenalty;
    }

    return Math.max(0, score); // 确保分数不为负
  };

  // 更新视频地址
  const updateVideoUrl = (
    detailData: SearchResult | null,
    episodeIndex: number
  ) => {
    if (
      !detailData ||
      !detailData.episodes ||
      episodeIndex >= detailData.episodes.length
    ) {
      setVideoUrl('');
      return;
    }
    const newUrl = detailData?.episodes[episodeIndex] || '';
    if (newUrl !== videoUrl) {
      setVideoUrl(newUrl);
    }
  };

  const ensureVideoSource = (video: HTMLVideoElement | null, url: string) => {
    if (!video || !url) return;
    const sources = Array.from(video.getElementsByTagName('source'));
    const existed = sources.some((s) => s.src === url);
    if (!existed) {
      // 移除旧的 source，保持唯一
      sources.forEach((s) => s.remove());
      const sourceEl = document.createElement('source');
      sourceEl.src = url;
      video.appendChild(sourceEl);
    }

    // 始终允许远程播放（AirPlay / Cast）
    video.disableRemotePlayback = false;
    // 如果曾经有禁用属性，移除之
    if (video.hasAttribute('disableRemotePlayback')) {
      video.removeAttribute('disableRemotePlayback');
    }
  };

  // Wake Lock 相关函数
  const requestWakeLock = async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await (navigator as any).wakeLock.request(
          'screen'
        );
        console.log('Wake Lock 已启用');
      }
    } catch (err) {
      console.warn('Wake Lock 请求失败:', err);
    }
  };

  const releaseWakeLock = async () => {
    try {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
        console.log('Wake Lock 已释放');
      }
    } catch (err) {
      console.warn('Wake Lock 释放失败:', err);
    }
  };

  // 清理播放器资源的统一函数
  const cleanupPlayer = () => {
    if (artPlayerRef.current) {
      try {
        // 销毁 HLS 实例
        if (artPlayerRef.current.video && artPlayerRef.current.video.hls) {
          artPlayerRef.current.video.hls.destroy();
        }

        // 销毁 ArtPlayer 实例
        artPlayerRef.current.destroy();
        artPlayerRef.current = null;

        console.log('播放器资源已清理');
      } catch (err) {
        console.warn('清理播放器资源时出错:', err);
        artPlayerRef.current = null;
      }
    }
  };

  // -----------------------------------------------------------------------------
  // 新增的超级 M3U8 广告算法过滤器
  // -----------------------------------------------------------------------------

  interface M3U8Segment {
    index: number;
    startLine: number;
    endLine: number;
    duration: number;
    url: string;
    hasDiscontinuity: boolean;
    hasMap: boolean;
    content: string;
    isAd: boolean;
    adScore: number;
    stats?: { deviation: number; zScore: number };
  }

  interface M3U8Headers {
    main: string[];
    other: string[];
  }

  interface M3U8Stats {
    avgDuration: number;
    stdDev: number;
    p10: number;
    p90: number;
    totalDuration: number;
    segmentCount: number;
    durationRange: [number, number];
  }

  /**
   * 超级M3U8广告算法过滤器
   * @param {string} m3u8Content - 原始M3U8内容
   * @param {string|null} regexFilter - 可选的正则过滤规则
   * @return {string} 过滤后的完整M3U8内容
   */
  function SuperFilterAdsFromM3U8(m3u8Content: string, regexFilter: string | null = null): string {
      if (!m3u8Content) return '';
      
      // ==================== 第一阶段：预处理 ====================
      // 1. 正则过滤
      const processedContent = regexFilter 
          ? applyRegexFilter(m3u8Content, regexFilter) 
          : m3u8Content;
      
      // 2. 解析M3U8结构
      const { segments, headers } = parseM3U8Structure(processedContent);
      if (segments.length === 0) return processedContent;
      
      // ==================== 第二阶段：科学分析 ====================
      // 1. 计算基础统计量
      const stats = calculateSegmentStats(segments);
      
      // 2. 多维度广告检测
      const analyzedSegments = analyzeSegmentsForAds(segments, stats);
      
      // 3. 智能过滤决策
      const filteredSegments = applyFilterDecision(analyzedSegments, stats);
      
      // ==================== 第三阶段：重建M3U8 ====================
      return rebuildM3U8(headers, filteredSegments, processedContent);
  }

  /**
   * 应用正则过滤
   */
  function applyRegexFilter(content: string, regexFilter: string): string {
      try {
          const regex = new RegExp(regexFilter, 'gi');
          return content.replace(regex, '');
      } catch (e) {
          console.warn('正则过滤失败:', e);
          return content;
      }
  }

  /**
   * 深度解析M3U8结构
   */
  function parseM3U8Structure(content: string): { segments: M3U8Segment[], headers: M3U8Headers } {
      const lines = content.split('\n');
      const segments: M3U8Segment[] = [];
      const headers: M3U8Headers = {
          main: [],
          other: []
      };
      let currentDiscontinuity = false;
      let currentMap: string | null = null;
      let segmentIndex = 0;

      for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          
          if (i < 10 && line.startsWith('#EXT')) {
              headers.main.push(line);
              continue;
          }
          
          if (line.startsWith('#EXT-X-MAP:')) {
              currentMap = line;
              continue;
          }
          
          if (line.includes('#EXT-X-DISCONTINUITY')) {
              currentDiscontinuity = true;
              continue;
          }
          
          if (line.startsWith('#EXTINF:')) {
              const durationMatch = line.match(/#EXTINF:([\d.]+)/);
              if (durationMatch && lines[i + 1] && !lines[i + 1].startsWith('#')) {
                  const duration = parseFloat(durationMatch[1]);
                  const url = lines[i + 1].trim();
                  
                  segments.push({
                      index: segmentIndex++,
                      startLine: i,
                      endLine: i + 1,
                      duration,
                      url,
                      hasDiscontinuity: currentDiscontinuity,
                      hasMap: currentMap !== null,
                      content: currentMap 
                          ? [currentMap, line, lines[i + 1]].join('\n')
                          : [line, lines[i + 1]].join('\n'),
                      isAd: false,
                      adScore: 0
                  });
                  
                  currentDiscontinuity = false;
                  currentMap = null;
                  i++;
              }
          } else if (line.startsWith('#')) {
              headers.other.push(line);
          }
      }
      
      return { segments, headers };
  }

  /**
   * 计算高级统计量
   */
  function calculateSegmentStats(segments: M3U8Segment[]): M3U8Stats {
      const durations = segments.map(s => s.duration);
      if (durations.length === 0) {
        return { avgDuration: 0, stdDev: 0, p10: 0, p90: 0, totalDuration: 0, segmentCount: 0, durationRange: [0, 0] };
      }
      const totalDuration = durations.reduce((sum, d) => sum + d, 0);
      const avgDuration = totalDuration / durations.length;
      
      const squaredDiffs = durations.map(d => Math.pow(d - avgDuration, 2));
      const stdDev = Math.sqrt(squaredDiffs.reduce((sum, sd) => sum + sd, 0) / durations.length);
      
      const sortedDurations = [...durations].sort((a, b) => a - b);
      const p10 = sortedDurations[Math.floor(durations.length * 0.1)] || 0;
      const p90 = sortedDurations[Math.floor(durations.length * 0.9)] || 0;
      
      return {
          avgDuration,
          stdDev,
          p10,
          p90,
          totalDuration,
          segmentCount: segments.length,
          durationRange: [sortedDurations[0] || 0, sortedDurations[sortedDurations.length - 1] || 0]
      };
  }

  /**
   * 多维度片段分析
   */
  function analyzeSegmentsForAds(segments: M3U8Segment[], stats: M3U8Stats): M3U8Segment[] {
      const { avgDuration, stdDev, p10, p90 } = stats;
      
      return segments.map(segment => {
          const deviation = Math.abs(segment.duration - avgDuration);
          const zScore = stdDev > 0 ? deviation / stdDev : 0;
          
          const durationAbnormality = Math.min(1, zScore / 3);
          
          let positionFactor = 0;
          if (segment.index < 3 && segment.duration < p10) {
              positionFactor = 0.8;
          } else if (segment.index > segments.length - 3 && segment.duration < p10) {
              positionFactor = 0.5;
          }
          
          const discontinuityFactor = segment.hasDiscontinuity ? 0.3 : 0;
          
          const adScore = Math.min(1, 
              (durationAbnormality * 0.6) + 
              (positionFactor * 0.3) + 
              (discontinuityFactor * 0.1)
          );
          
          return {
              ...segment,
              adScore,
              isAd: adScore > 0.65,
              stats: { deviation, zScore }
          };
      });
  }

  /**
   * 智能过滤决策
   */
  function applyFilterDecision(segments: M3U8Segment[], stats: M3U8Stats): M3U8Segment[] {
      const { avgDuration, stdDev } = stats;
      
      const baseThreshold = 0.65;
      const dynamicThreshold = (avgDuration > 0 && stdDev > 0) 
        ? Math.min(0.8, Math.max(0.5, baseThreshold - (stdDev / avgDuration) * 0.2))
        : baseThreshold;
      
      return segments.filter(segment => {
          if (segment.isAd && segment.adScore > dynamicThreshold) {
              return false;
          }
          
          if (segment.duration < 1.0 && segment.index > 3) {
              return false;
          }
          
          if (segment.hasMap) {
              return true;
          }
          
          return true;
      });
  }

  /**
   * 完美重建M3U8
   */
  function rebuildM3U8(headers: M3U8Headers, segments: M3U8Segment[], originalContent: string): string {
      const originalLines = originalContent.split('\n');
      const keepLines = new Set<number>();
      
      headers.main.forEach((_, i) => {
        if (i < originalLines.length) keepLines.add(i)
      });
      
      segments.forEach(segment => {
          for (let i = segment.startLine; i <= segment.endLine; i++) {
              keepLines.add(i);
          }
      });
      
      const criticalTags = [
          '#EXT-X-VERSION',
          '#EXT-X-TARGETDURATION',
          '#EXT-X-MEDIA-SEQUENCE',
          '#EXT-X-PLAYLIST-TYPE',
          '#EXT-X-ENDLIST'
      ];
      
      for (let i = 0; i < originalLines.length; i++) {
          const line = originalLines[i].trim();
          if (criticalTags.some(tag => line.startsWith(tag))) {
              keepLines.add(i);
          }
      }
      
      const filteredLines = originalLines.filter((_, i) => keepLines.has(i));
      
      updateM3U8Headers(filteredLines, segments);
      
      return filteredLines.join('\n');
  }

  /**
   * 更新M3U8头部信息
   */
  function updateM3U8Headers(lines: string[], segments: M3U8Segment[]) {
      if (segments.length === 0) return;
      
      const maxDuration = Math.max(...segments.map(s => s.duration));
      let targetDurationUpdated = false;
      for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('#EXT-X-TARGETDURATION')) {
              lines[i] = `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`;
              targetDurationUpdated = true;
              break;
          }
      }

      if (!targetDurationUpdated) {
        const versionIndex = lines.findIndex(line => line.startsWith('#EXT-X-VERSION'));
        if (versionIndex !== -1) {
          lines.splice(versionIndex + 1, 0, `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`);
        }
      }
      
      if (segments.length > 0 && segments[0].index > 0) {
          let mediaSequenceUpdated = false;
          for (let i = 0; i < lines.length; i++) {
              if (lines[i].startsWith('#EXT-X-MEDIA-SEQUENCE')) {
                  lines[i] = `#EXT-X-MEDIA-SEQUENCE:${segments[0].index}`;
                  mediaSequenceUpdated = true;
                  break;
              }
          }
          if (!mediaSequenceUpdated) {
            const targetDurationIndex = lines.findIndex(line => line.startsWith('#EXT-X-TARGETDURATION'));
            if (targetDurationIndex !== -1) {
              lines.splice(targetDurationIndex + 1, 0, `#EXT-X-MEDIA-SEQUENCE:${segments[0].index}`);
            }
          }
      }
  }

  // 高级 M3U8 过滤的辅助函数
  function extract_number_before_ts(str: string): number | null {
    const match = str.match(/(\d+)\.ts/);
    if (match) {
      return parseInt(match[1], 10);
    }
    return null;
  }

  // Levenshtein 距离计算函数
  function levenshteinDistance(s: string, t: string): number {
    if (s.length === 0) return t.length;
    if (t.length === 0) return s.length;

    const distanceMatrix: number[][] = Array(t.length + 1).fill(null).map(() => Array(s.length + 1).fill(null as any));

    for (let i = 0; i <= s.length; i += 1) {
      distanceMatrix[0][i] = i;
    }

    for (let j = 0; j <= t.length; j += 1) {
      distanceMatrix[j][0] = j;
    }

    for (let j = 1; j <= t.length; j += 1) {
      for (let i = 1; i <= s.length; i += 1) {
        const substitutionCost = s.charAt(i - 1) === t.charAt(j - 1) ? 0 : 1;
        distanceMatrix[j][i] = Math.min(
          distanceMatrix[j][i - 1] + 1,
          distanceMatrix[j - 1][i] + 1,
          distanceMatrix[j - 1][i - 1] + substitutionCost
        );
      }
    }
    return distanceMatrix[t.length][s.length];
  }

  // 高级 M3U8 过滤逻辑
  function advancedFilterM3U8Lines(m3u8Content: string): string {
    const lines = m3u8Content.split('\n');
    const result: string[] = [];

    let ts_name_len = 0;
    let ts_name_len_extend = 1;
    let first_extinf_row = '';
    let the_extinf_judge_row_n = 0;
    let the_same_extinf_name_n = 0;
    let the_extinf_benchmark_n = 5;
    let prev_ts_name_index = -1;
    let first_ts_name_index = -1;
    let ts_type = 0;
    let the_ext_x_mode = 0;

    // Levenshtein 距离逻辑相关的变量
    let last_uri_path = '';
    let max_distance = 0;
    let avg_distance = 0;
    let n = 0;

    // --- ts_type 自动检测 ---
    let detected_ts_type = 2; // 如果未找到特定模式，则默认为暴力模式

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (the_extinf_judge_row_n === 0 && line.startsWith('#EXTINF')) {
        first_extinf_row = line;
        the_extinf_judge_row_n++;
      } else if (the_extinf_judge_row_n === 1 && line.startsWith('#EXTINF')) {
        if (line !== first_extinf_row) {
          first_extinf_row = '';
        }
        the_extinf_judge_row_n++;
      }

      let the_ts_name_len_current = line.indexOf('.ts');
      if (the_ts_name_len_current > 0) {
        if (ts_name_len === 0) {
          ts_name_len = the_ts_name_len_current;
        }

        let ts_name_index = extract_number_before_ts(line);
        if (ts_name_index !== null) {
          if (first_ts_name_index === -1) {
            first_ts_name_index = ts_name_index;
            prev_ts_name_index = first_ts_name_index - 1;
          }

          if (ts_name_index === prev_ts_name_index + 1) {
            detected_ts_type = 0;
            prev_ts_name_index = ts_name_index;
          } else {
            detected_ts_type = 2;
            break;
          }
        } else {
          detected_ts_type = 1;
        }
      }
    }
    ts_type = detected_ts_type;

    // --- 过滤逻辑 ---
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Levenshtein 距离检查（应用于 .ts 行）
      const uri_path_match = line.match(/^.*[.](ts|jpg|png|jpeg)(?=$|\?|#)/);
      if (uri_path_match && uri_path_match[0]) {
        const current_uri_path = uri_path_match[0];
        if (last_uri_path !== '') {
          const distance = levenshteinDistance(current_uri_path, last_uri_path);
          if (max_distance !== 0 && max_distance < 10 && distance > max_distance) {
            // 此片段很可能是广告，跳过它
            // 查找下一个 #EXT-X-DISCONTINUITY 或文件末尾
            let j = i;
            while (j < lines.length && !lines[j].startsWith('#EXT-X-DISCONTINUITY')) {
              j++;
            }
            i = j - 1; // 将 i 设置为下一个不连续点或文件末尾之前的行
            continue;
          }
          avg_distance = (n * avg_distance + distance) / (n + 1);
          n += 1;
        }
        last_uri_path = current_uri_path;
        if (levenshteinDistance(current_uri_path, last_uri_path) > max_distance) {
          max_distance = levenshteinDistance(current_uri_path, last_uri_path);
        }
      }


      if (ts_type === 0) {
        if (line.startsWith('#EXT-X-DISCONTINUITY') && lines[i + 1] && lines[i + 2]) {
          if (i > 0 && lines[i - 1].startsWith('#EXT-X-')) {
            result.push(line);
            continue;
          }
          else {
            let the_ts_name_len_current = lines[i + 2].indexOf('.ts');
            if (the_ts_name_len_current > 0) {
              if (Math.abs(the_ts_name_len_current - ts_name_len) > ts_name_len_extend) {
                if (lines[i + 3] && lines[i + 3].startsWith('#EXT-X-DISCONTINUITY')) {
                  i += 3;
                } else {
                  i += 2;
                }
                continue;
              } else {
                ts_name_len = the_ts_name_len_current;
              }

              let the_ts_name_index = extract_number_before_ts(lines[i + 2]);
              if (the_ts_name_index !== null && the_ts_name_index !== prev_ts_name_index + 1) {
                if (lines[i + 3] && lines[i + 3].startsWith('#EXT-X-DISCONTINUITY')) {
                  i += 3;
                } else {
                  i += 2;
                }
                continue;
              }
              if (the_ts_name_index !== null) {
                prev_ts_name_index = the_ts_name_index;
              }
            }
          }
        }

        if (line.startsWith('#EXTINF') && lines[i + 1]) {
          let the_ts_name_len_current = lines[i + 1].indexOf('.ts');
          if (the_ts_name_len_current > 0) {
            if (Math.abs(the_ts_name_len_current - ts_name_len) > ts_name_len_extend) {
              if (lines[i + 2] && lines[i + 2].startsWith('#EXT-X-DISCONTINUITY')) {
                i += 2;
              } else {
                i += 1;
              }
              continue;
            } else {
              ts_name_len = the_ts_name_len_current;
            }

            let the_ts_name_index = extract_number_before_ts(lines[i + 1]);
            if (the_ts_name_index !== null) {
              if (the_ts_name_index === prev_ts_name_index + 1) {
                prev_ts_name_index++;
              } else {
                if (lines[i + 2] && lines[i + 2].startsWith('#EXT-X-DISCONTINUITY')) {
                  i += 2;
                } else {
                  i += 1;
                }
                continue;
              }
            }
          }
        }
      } else if (ts_type === 1) {
        if (line.startsWith('#EXTINF')) {
          if (line === first_extinf_row && the_same_extinf_name_n <= the_extinf_benchmark_n && the_ext_x_mode === 0) {
            the_same_extinf_name_n++;
          } else {
            the_ext_x_mode = 1;
          }

          if (the_same_extinf_name_n > the_extinf_benchmark_n) {
            the_ext_x_mode = 1;
          }
        }

        if (line.startsWith('#EXT-X-DISCONTINUITY')) {
          if (i > 0 && lines[i - 1].startsWith('#EXT-X-PLAYLIST-TYPE')) {
            result.push(line);
            continue;
          } else {
            if (lines[i + 1] && lines[i + 1].startsWith('#EXTINF') && lines[i + 2] && lines[i + 2].indexOf('.ts') > 0) {
              let the_ext_x_discontinuity_condition_flag = false;
              if (the_ext_x_mode === 1) {
                the_ext_x_discontinuity_condition_flag = lines[i + 1] !== first_extinf_row && the_same_extinf_name_n > the_extinf_benchmark_n;
              }

              if (lines[i + 3] && lines[i + 3].startsWith('#EXT-X-DISCONTINUITY') && the_ext_x_discontinuity_condition_flag) {
                i += 3;
              } else {
              }
              continue;
            }
          }
        }
      } else { // ts_type === 2 (暴力模式)
        if (line.startsWith('#EXT-X-DISCONTINUITY')) {
          if (i > 0 && lines[i - 1].startsWith('#EXT-X-PLAYLIST-TYPE')) {
            result.push(line);
            continue;
          } else {
            continue;
          }
        }
      }

      result.push(line);
    }

    return result.join('\n');
  }

  // 现有 filterAdsFromM3U8 函数，现在调用高级逻辑
  function filterAdsFromM3U8(m3u8Content: string): string {
    if (!m3u8Content) return '';
    
    // 首先，应用现有的广告过滤逻辑
    const partiallyFiltered = advancedFilterM3U8Lines(m3u8Content);
    
    // 然后，应用新的、更智能的广告过滤逻辑
    const fullyFiltered = SuperFilterAdsFromM3U8(partiallyFiltered);
    
    return fullyFiltered;
  }

  // 跳过片头片尾配置相关函数
  const handleSkipConfigChange = async (newConfig: {
    enable: boolean;
    intro_time: number;
    outro_time: number;
  }) => {
    if (!currentSourceRef.current || !currentIdRef.current) return;

    try {
      setSkipConfig(newConfig);
      if (!newConfig.enable && !newConfig.intro_time && !newConfig.outro_time) {
        await deleteSkipConfig(currentSourceRef.current, currentIdRef.current);
        artPlayerRef.current.setting.update({
          name: '跳过片头片尾',
          html: '跳过片头片尾',
          switch: skipConfigRef.current.enable,
          onSwitch: function (item: any) {
            const newConfig = {
              ...skipConfigRef.current,
              enable: !item.switch,
            };
            handleSkipConfigChange(newConfig);
            return !item.switch;
          },
        });
        artPlayerRef.current.setting.update({
          name: '设置片头',
          html: '设置片头',
          icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="12" r="2" fill="#ffffff"/><path d="M9 12L17 12" stroke="#ffffff" stroke-width="2"/><path d="M17 6L17 18" stroke="#ffffff" stroke-width="2"/></svg>',
          tooltip:
            skipConfigRef.current.intro_time === 0
              ? '设置片头时间'
              : `${formatTime(skipConfigRef.current.intro_time)}`,
          onClick: function () {
            const currentTime = artPlayerRef.current?.currentTime || 0;
            if (currentTime > 0) {
              const newConfig = {
                ...skipConfigRef.current,
                intro_time: currentTime,
              };
              handleSkipConfigChange(newConfig);
              return `${formatTime(currentTime)}`;
            }
          },
        });
        artPlayerRef.current.setting.update({
          name: '设置片尾',
          html: '设置片尾',
          icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 6L7 18" stroke="#ffffff" stroke-width="2"/><path d="M7 12L15 12" stroke="#ffffff" stroke-width="2"/><circle cx="19" cy="12" r="2" fill="#ffffff"/></svg>',
          tooltip:
            skipConfigRef.current.outro_time >= 0
              ? '设置片尾时间'
              : `-${formatTime(-skipConfigRef.current.outro_time)}`,
          onClick: function () {
            const outroTime =
              -(artPlayerRef.current?.duration - artPlayerRef.current?.currentTime) || 0;
            if (outroTime < 0) {
              const newConfig = {
                ...skipConfigRef.current,
                outro_time: outroTime,
              };
              handleSkipConfigChange(newConfig);
              return `-${formatTime(-outroTime)}`;
            }
          },
        });
      } else {
        await saveSkipConfig(
          currentSourceRef.current,
          currentIdRef.current,
          newConfig
        );
      }
      console.log('跳过片头片尾配置已保存:', newConfig);
    } catch (err) {
      console.error('保存跳过片头片尾配置失败:', err);
    }
  };

  const formatTime = (seconds: number): string => {
    if (seconds === 0) return '00:00';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = Math.round(seconds % 60);

    if (hours === 0) {
      // 不到一小时，格式为 00:00
      return `${minutes.toString().padStart(2, '0')}:${remainingSeconds
        .toString()
        .padStart(2, '0')}`;
    } else {
      // 超过一小时，格式为 00:00:00
      return `${hours.toString().padStart(2, '0')}:${minutes
        .toString()
        .padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }
  };

  

  // 当集数索引变化时自动更新视频地址
  useEffect(() => {
    updateVideoUrl(detail, currentEpisodeIndex);
  }, [detail, currentEpisodeIndex]);

  // 进入页面时直接获取全部源信息
  useEffect(() => {
    const fetchSourceDetail = async (
      source: string,
      id: string
    ): Promise<SearchResult[]> => {
      try {
        const detailResponse = await fetch(
          `/api/detail?source=${source}&id=${id}`
        );
        if (!detailResponse.ok) {
          throw new Error('获取视频详情失败');
        }
        const detailData = (await detailResponse.json()) as SearchResult;
        setAvailableSources([detailData]);
        return [detailData];
      } catch (err) {
        console.error('获取视频详情失败:', err);
        return [];
      } finally {
        setSourceSearchLoading(false);
      }
    };
    const fetchSourcesData = async (query: string): Promise<SearchResult[]> => {
      // 根据搜索词获取全部源信息
      try {
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(query.trim())}`
        );
        if (!response.ok) {
          throw new Error('搜索失败');
        }
        const data = await response.json();

        // 处理搜索结果，根据规则过滤
        const results = data.results.filter(
          (result: SearchResult) =>
            result.title.replaceAll(' ', '').toLowerCase() ===
              videoTitleRef.current.replaceAll(' ', '').toLowerCase() &&
            (videoYearRef.current
              ? result.year.toLowerCase() === videoYearRef.current.toLowerCase()
              : true) &&
            (searchType
              ? (searchType === 'tv' && result.episodes.length > 1) ||
                (searchType === 'movie' && result.episodes.length === 1)
              : true)
        );
        setAvailableSources(results);
        return results;
      } catch (err) {
        setSourceSearchError(err instanceof Error ? err.message : '搜索失败');
        setAvailableSources([]);
        return [];
      } finally {
        setSourceSearchLoading(false);
      }
    };

    const initAll = async () => {
      if (!currentSource && !currentId && !videoTitle && !searchTitle) {
        setError('缺少必要参数');
        setLoading(false);
        return;
      }
      setLoading(true);
      setLoadingStage(currentSource && currentId ? 'fetching' : 'searching');
      setLoadingMessage(
        currentSource && currentId
          ? '正在获取影片信息'
          : '正在获取影片信息'
      );

      let sourcesInfo = await fetchSourcesData(searchTitle || videoTitle);
      if (
        currentSource &&
        currentId &&
        !sourcesInfo.some(
          (source) => source.source === currentSource && source.id === currentId
        )
      ) {
        sourcesInfo = await fetchSourceDetail(currentSource, currentId);
      }
      if (sourcesInfo.length === 0) {
        setError('未找到匹配结果');
        setLoading(false);
        return;
      }

      let detailData: SearchResult = sourcesInfo[0];
      let historyRecord = null;
      if (currentSource && currentId) {
        try {
          const allRecords = await getAllPlayRecords();
          const key = generateStorageKey(currentSource, currentId);
          historyRecord = allRecords[key];
        } catch (err) {
          console.error('读取播放记录失败:', err);
        }
      }

      // 指定源和id且无需优选 (包括从“继续观看”来的)
      if (currentSource && currentId && !needPreferRef.current) {
        const target = sourcesInfo.find(
          (source) => source.source === currentSource && source.id === currentId
        );
        if (target) {
          detailData = target;
        } else {
          setError('未找到匹配结果');
          setLoading(false);
          return;
        }
      }
      // 未指定源和 id 或需要优选，且开启优选开关
      else if (optimizationEnabled) {
        setLoadingStage('preferring');
        setLoadingMessage('正在优选最佳路线');

        detailData = await preferBestSource(sourcesInfo);
      }

      console.log(detailData.source, detailData.id);

      setNeedPrefer(false);
      setCurrentSource(detailData.source);
      setCurrentId(detailData.id);
      setVideoYear(detailData.year);
      setVideoTitle(detailData.title || videoTitleRef.current);
      setVideoCover(detailData.poster);
      setVideoDoubanId(detailData.douban_id || 0);
      setDetail(detailData);

      if (historyRecord) {
        const targetIndex = historyRecord.index - 1;
        const targetTime = historyRecord.play_time;

        // 更新当前集数索引
        if (targetIndex !== currentEpisodeIndex) {
          setCurrentEpisodeIndex(targetIndex);
        }

        // 保存待恢复的播放进度，待播放器就绪后跳转
        resumeTimeRef.current = targetTime;
      } else {
        if (currentEpisodeIndex >= detailData.episodes.length) {
          setCurrentEpisodeIndex(0);
        }
      }

      // 规范URL参数
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('source', detailData.source);
      newUrl.searchParams.set('id', detailData.id);
      newUrl.searchParams.set('year', detailData.year);
      newUrl.searchParams.set('title', detailData.title);
      newUrl.searchParams.delete('prefer');
      window.history.replaceState({}, '', newUrl.toString());

      setLoadingStage('ready');
      setLoadingMessage('准备就绪');

      // 短暂延迟让用户看到完成状态
      setTimeout(() => {
        setLoading(false);
      }, 1000);
    };

    initAll();
  }, []);

  // 跳过片头片尾配置处理
  useEffect(() => {
    // 仅在初次挂载时检查跳过片头片尾配置
    const initSkipConfig = async () => {
      if (!currentSource || !currentId) return;

      try {
        const config = await getSkipConfig(currentSource, currentId);
        if (config) {
          setSkipConfig(config);
        }
      } catch (err) {
        console.error('读取跳过片头片尾配置失败:', err);
      }
    };

    initSkipConfig();
  }, []);

  // 处理路线
  const handleSourceChange = async (
    newSource: string,
    newId: string,
    newTitle: string
  ) => {
    try {
      // 显示路线加载状态
      setVideoLoadingStage('sourceChanging');
      setIsVideoLoading(true);

      // 记录当前播放进度（仅在同一集数切换时恢复）
      const currentPlayTime = artPlayerRef.current?.currentTime || 0;
      console.log('路线前当前播放时间:', currentPlayTime);

      // 清除前一个历史记录
      if (currentSourceRef.current && currentIdRef.current) {
        try {
          await deletePlayRecord(
            currentSourceRef.current,
            currentIdRef.current
          );
          console.log('已清除前一个播放记录');
        } catch (err) {
          console.error('清除播放记录失败:', err);
        }
      }

      // 清除并设置下一个跳过片头片尾配置
      if (currentSourceRef.current && currentIdRef.current) {
        try {
          await deleteSkipConfig(
            currentSourceRef.current,
            currentIdRef.current
          );
          await saveSkipConfig(newSource, newId, skipConfigRef.current);
        } catch (err) {
          console.error('清除跳过片头片尾配置失败:', err);
        }
      }

      // 倍速随线路一起迁移：同一部剧换线路，倍速要保持住
      if (currentSourceRef.current && currentIdRef.current) {
        try {
          await deletePlaybackRateConfig(
            currentSourceRef.current,
            currentIdRef.current
          );
          await savePlaybackRateConfig(newSource, newId, {
            rate: playbackRateRef.current,
          });
        } catch (err) {
          console.error('迁移播放倍速配置失败:', err);
        }
      }

      const newDetail = availableSources.find(
        (source) => source.source === newSource && source.id === newId
      );
      if (!newDetail) {
        setError('未找到匹配结果');
        return;
      }

      // 尝试跳转到当前正在播放的集数
      let targetIndex = currentEpisodeIndex;

      // 如果当前集数超出新源的范围，则跳转到第一集
      if (!newDetail.episodes || targetIndex >= newDetail.episodes.length) {
        targetIndex = 0;
      }

      // 如果仍然是同一集数且播放进度有效，则在播放器就绪后恢复到原始进度
      if (targetIndex !== currentEpisodeIndex) {
        resumeTimeRef.current = 0;
      } else if (
        (!resumeTimeRef.current || resumeTimeRef.current === 0) &&
        currentPlayTime > 1
      ) {
        resumeTimeRef.current = currentPlayTime;
      }

      // 更新URL参数（不刷新页面）
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('source', newSource);
      newUrl.searchParams.set('id', newId);
      newUrl.searchParams.set('year', newDetail.year);
      window.history.replaceState({}, '', newUrl.toString());

      setVideoTitle(newDetail.title || newTitle);
      setVideoYear(newDetail.year);
      setVideoCover(newDetail.poster);
      setVideoDoubanId(newDetail.douban_id || 0);
      setCurrentSource(newSource);
      setCurrentId(newId);
      setDetail(newDetail);
      setCurrentEpisodeIndex(targetIndex);
    } catch (err) {
      // 隐藏路线加载状态
      setIsVideoLoading(false);
      setError(err instanceof Error ? err.message : '路线失败');
    }
  };

  useEffect(() => {
    document.addEventListener('keydown', handleKeyboardShortcuts);
    return () => {
      document.removeEventListener('keydown', handleKeyboardShortcuts);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 集数切换
  // ---------------------------------------------------------------------------
  // 重置长按加速状态（切集 / 换源 / 卸载时调用）
  const resetLongPressRaceState = () => {
    if (longPressRateTimerRef.current) {
      clearTimeout(longPressRateTimerRef.current);
      longPressRateTimerRef.current = null;
    }
    if (longPressRateActiveRef.current) {
      longPressRateActiveRef.current = false;
      setIsLongPressRacing(false);
    }
  };

  // 处理集数切换
  const handleEpisodeChange = (episodeNumber: number) => {
    setLongPressedTitle(null);
    setIsFadingOut(false); // 确保没有淡出动画在进行
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (fadeOutTimerRef.current) {
      clearTimeout(fadeOutTimerRef.current);
      fadeOutTimerRef.current = null;
    }
    // 清掉可能残留的长按加速状态
    resetLongPressRaceState();

    if (episodeNumber >= 0 && episodeNumber < totalEpisodes) {
      // 在更换集数前保存当前播放进度
      if (artPlayerRef.current && artPlayerRef.current.paused) {
        saveCurrentPlayProgress();
      }
      setCurrentEpisodeIndex(episodeNumber);
    }
  };

  const handleLongPress = (title: string) => {
    // 清除任何现有计时器
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
    }
    if (fadeOutTimerRef.current) {
      clearTimeout(fadeOutTimerRef.current);
    }

    setIsFadingOut(false); // 确保新标题出现时不是淡出状态
    setLongPressedTitle(title); // 显示标题

    longPressTimerRef.current = setTimeout(() => {
      setIsFadingOut(true); // 触发淡出动画
      fadeOutTimerRef.current = setTimeout(() => {
        setLongPressedTitle(null); // 淡出动画完成后隐藏元素
        longPressTimerRef.current = null;
        fadeOutTimerRef.current = null;
        setIsFadingOut(false); // 重置状态以便下次使用
      }, 500); // 淡出动画的持续时间
    }, 2500); // 淡出动画开始前的延迟（总共3秒）
  };

  const handlePreviousEpisode = () => {
    const d = detailRef.current;
    const idx = currentEpisodeIndexRef.current;
    if (d && d.episodes && idx > 0) {
      if (artPlayerRef.current && !artPlayerRef.current.paused) {
        saveCurrentPlayProgress();
      }
      setCurrentEpisodeIndex(idx - 1);
    }
  };

  const handleNextEpisode = () => {
    const d = detailRef.current;
    const idx = currentEpisodeIndexRef.current;
    if (d && d.episodes && idx < d.episodes.length - 1) {
      if (artPlayerRef.current && !artPlayerRef.current.paused) {
        saveCurrentPlayProgress();
      }
      setCurrentEpisodeIndex(idx + 1);
    }
  };

  // ---------------------------------------------------------------------------
  // 键盘快捷键
  // ---------------------------------------------------------------------------
  // 处理全局快捷键
  const handleKeyboardShortcuts = (e: KeyboardEvent) => {
    // 忽略输入框中的按键事件
    if (
      (e.target as HTMLElement).tagName === 'INPUT' ||
      (e.target as HTMLElement).tagName === 'TEXTAREA'
    )
      return;

    // Alt + 左箭头 = 上一集
    if (e.altKey && e.key === 'ArrowLeft') {
      if (detailRef.current && currentEpisodeIndexRef.current > 0) {
        handlePreviousEpisode();
        e.preventDefault();
      }
    }

    // Alt + 右箭头 = 下一集
    if (e.altKey && e.key === 'ArrowRight') {
      const d = detailRef.current;
      const idx = currentEpisodeIndexRef.current;
      if (d && idx < d.episodes.length - 1) {
        handleNextEpisode();
        e.preventDefault();
      }
    }

    // 左箭头 = 快退
    if (!e.altKey && e.key === 'ArrowLeft') {
      if (artPlayerRef.current && artPlayerRef.current.currentTime > 5) {
        artPlayerRef.current.currentTime -= 10;
        e.preventDefault();
      }
    }

    // 右箭头 = 快进
    if (!e.altKey && e.key === 'ArrowRight') {
      if (
        artPlayerRef.current &&
        artPlayerRef.current.currentTime < artPlayerRef.current.duration - 5
      ) {
        artPlayerRef.current.currentTime += 10;
        e.preventDefault();
      }
    }

    // 上箭头 = 音量+
    if (e.key === 'ArrowUp') {
      if (artPlayerRef.current && artPlayerRef.current.volume < 1) {
        artPlayerRef.current.volume =
          Math.round((artPlayerRef.current.volume + 0.1) * 10) / 10;
        artPlayerRef.current.notice.show = `音量: ${Math.round(
          artPlayerRef.current.volume * 100
        )}`;
        e.preventDefault();
      }
    }

    // 下箭头 = 音量-
    if (e.key === 'ArrowDown') {
      if (artPlayerRef.current && artPlayerRef.current.volume > 0) {
        artPlayerRef.current.volume =
          Math.round((artPlayerRef.current.volume - 0.1) * 10) / 10;
        artPlayerRef.current.notice.show = `音量: ${Math.round(
          artPlayerRef.current.volume * 100
        )}`;
        e.preventDefault();
      }
    }

    // 空格 = 播放/暂停
    if (e.key === ' ') {
      if (artPlayerRef.current) {
        artPlayerRef.current.toggle();
        e.preventDefault();
      }
    }

    // f 键 = 切换全屏
    if (e.key === 'f' || e.key === 'F') {
      if (artPlayerRef.current) {
        artPlayerRef.current.fullscreen = !artPlayerRef.current.fullscreen;
        e.preventDefault();
      }
    }
  };

  // ---------------------------------------------------------------------------
  // 播放记录相关
  // ---------------------------------------------------------------------------
  // 保存播放进度
  const saveCurrentPlayProgress = async () => {
    if (
      !artPlayerRef.current ||
      !currentSourceRef.current ||
      !currentIdRef.current ||
      !videoTitleRef.current ||
      !detailRef.current?.source_name
    ) {
      return;
    }

    const player = artPlayerRef.current;
    const currentTime = player.currentTime || 0;
    const duration = player.duration || 0;

    // 如果播放时间太短（少于5秒）或者视频时长无效，不保存
    if (currentTime < 1 || !duration) {
      return;
    }

    try {
      await savePlayRecord(currentSourceRef.current, currentIdRef.current, {
        title: videoTitleRef.current,
        source_name: detailRef.current?.source_name || '',
        year: detailRef.current?.year,
        cover: detailRef.current?.poster || '',
        index: currentEpisodeIndexRef.current + 1, // 转换为1基索引
        total_episodes: detailRef.current?.episodes.length || 1,
        play_time: Math.floor(currentTime),
        total_time: Math.floor(duration),
        save_time: Date.now(),
        search_title: searchTitle,
      });

      lastSaveTimeRef.current = Date.now();
      console.log('播放进度已保存:', {
        title: videoTitleRef.current,
        episode: currentEpisodeIndexRef.current + 1,
        year: detailRef.current?.year,
        progress: `${Math.floor(currentTime)}/${Math.floor(duration)}`,
      });
    } catch (err) {
      console.error('保存播放进度失败:', err);
    }
  };

  useEffect(() => {
    // 页面即将卸载时保存播放进度和清理资源
    const handleBeforeUnload = () => {
      saveCurrentPlayProgress();
      releaseWakeLock();
      cleanupPlayer();
    };

    // 页面可见性变化时保存播放进度和释放 Wake Lock
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveCurrentPlayProgress();
        releaseWakeLock();
      } else if (document.visibilityState === 'visible') {
        // 页面重新可见时，如果正在播放则重新请求 Wake Lock
        if (artPlayerRef.current && !artPlayerRef.current.paused) {
          requestWakeLock();
        }
      }
    };

    // 添加事件监听器
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      // 清理事件监听器
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentEpisodeIndex, detail, artPlayerRef.current]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
      }
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
      if (fadeOutTimerRef.current) {
        clearTimeout(fadeOutTimerRef.current);
      }
    };
  }, []);

  

  function getPlaybackRateSelector(): PlaybackRateSelector[] {
    return PLAYBACK_RATE_OPTIONS.map(rate => ({
      name: `${rate}x`,
      value: rate,
      html: `${rate}x`
    }));
  }

  // 记录用户设定的倍速（按「登录用户 + 剧集」维度写入数据库，与跳过片头片尾同构）
  const applyUserPlaybackRate = (rate: number) => {
    playbackRateRef.current = rate;
    const source = currentSourceRef.current;
    const id = currentIdRef.current;
    if (source && id) {
      // 乐观更新 + 异步落库；失败只打日志，不影响本次播放
      void savePlaybackRateConfig(source, id, { rate });
    }
  };

  // 将倍速写入播放器，并同步控制栏上的倍速文案
  //
  // 注意：这里**不能**用 `art.controls.update({ name, html })` 来更新文案。
  // artplayer 的 Component.update() 实现是「remove + add」，即销毁控件再重建；
  // 而 selector 的每一项在首次渲染时被 `Object.defineProperty`（configurable: false）
  // 写入了 `$control_option` / `$control_item` / `$control_value` 三个只读属性，
  // 重建时对同一批 item 对象再次定义会抛 TypeError，**循环在第 1 项就中断**，
  // 菜单里就只剩「2x」一项（异常还会被 try/catch 静默吞掉，极难发现）。
  // 所以这里直接改文案节点的 innerHTML，并手动维护 art-current 高亮。
  const applyPlaybackRateToPlayer = (rate: number) => {
    const art = artPlayerRef.current;
    if (!art) return;
    try {
      const video = art.video as HTMLVideoElement | undefined;
      if (video && Math.abs(video.playbackRate - rate) > 0.001) {
        // 直接操作 video，避免 artplayer 弹出 "Rate: x" 的 notice 干扰
        video.playbackRate = rate;
      }
    } catch (_) {
      // ignore
    }
    try {
      const $control = art.controls?.['playback-rate'] as HTMLElement | undefined;
      const $value = $control?.querySelector('.art-selector-value');
      if ($value) {
        $value.innerHTML = `<b>${formatPlaybackRateText(rate)}</b>`;
      }
      $control?.querySelectorAll('.art-selector-item').forEach($item => {
        const value = Number.parseFloat(
          ($item as HTMLElement).dataset.value || ''
        );
        $item.classList.toggle(
          'art-current',
          Math.abs(value - rate) < 0.001
        );
      });
    } catch (_) {
      // 控制栏尚未就绪时忽略
    }
  };

  // 读取「当前登录用户 + 当前剧集」的倍速并套用。
  //
  // 与跳过片头片尾一样存在数据库里（键 u:{用户}:rate:{source}+{id}），所以：
  // - 同一部剧跳集 / 重进页面 / 换线路：保持该剧自己的倍速；
  // - 换一部剧：读回那部剧自己的倍速，**没有记录时回到默认 1x**（不再是上一部剧的值）。
  useEffect(() => {
    if (!currentSource || !currentId) return;

    let cancelled = false;

    const loadPlaybackRate = async () => {
      let rate = 1.0;
      try {
        const config = await getPlaybackRateConfig(currentSource, currentId);
        if (config && isValidPlaybackRate(config.rate)) {
          rate = config.rate;
        }
      } catch (err) {
        console.error('读取播放倍速配置失败:', err);
      }

      if (cancelled) return;
      playbackRateRef.current = rate;
      applyPlaybackRateToPlayer(rate);
    };

    loadPlaybackRate();

    return () => {
      cancelled = true;
    };
  }, [currentSource, currentId]);

  useEffect(() => {
    if (
      !Artplayer ||
      !Hls ||
      !videoUrl ||
      loading ||
      currentEpisodeIndex === null ||
      !artRef.current
    ) {
      return;
    }

    // 确保集数索引有效
    if (
      !detail ||
      !detail.episodes ||
      currentEpisodeIndex >= detail.episodes.length ||
      currentEpisodeIndex < 0
    ) {
      setError(`集数索引无效，当前共 ${totalEpisodes} 集`);
      return;
    }

    if (!videoUrl) {
      setError('视频地址无效');
      return;
    }
    console.log(videoUrl);

    // 检测是否为WebKit浏览器
    const isWebkit =
      typeof window !== 'undefined' &&
      typeof (window as any).webkitConvertPointFromNodeToPage === 'function';

    // 非WebKit浏览器且播放器已存在，使用switch方法切换
    if (!isWebkit && artPlayerRef.current) {
      // 切换前重置长按加速状态，避免状态残留
      resetLongPressRaceState();
      artPlayerRef.current.switch = videoUrl;
      artPlayerRef.current.title = `${videoTitle} - 第${
        currentEpisodeIndex + 1
      }集`;
      if (artPlayerRef.current?.video) {
        ensureVideoSource(
          artPlayerRef.current.video as HTMLVideoElement,
          videoUrl
        );
      }
      // 保持用户设定的倍速与文案（switch 完成后的 canplay 会再次校正）
      applyPlaybackRateToPlayer(playbackRateRef.current);
      return;
    }

    // WebKit浏览器或首次创建：销毁之前的播放器实例并创建新的
    if (artPlayerRef.current) {
      cleanupPlayer();
    }
    // 重建播放器时同样重置长按加速状态
    resetLongPressRaceState();

    try {
      // 创建新的播放器实例
      Artplayer.PLAYBACK_RATE = [0.5, 0.75, 1, 1.25, 1.5, 2];
      Artplayer.USE_RAF = true;

      artPlayerRef.current = new Artplayer({
        container: artRef.current,
        url: videoUrl,
        poster: '/assets/img/poster.png', // 占位海报，避免首次加载时的空白
        volume: 1.0,
        isLive: false,
        muted: false,
        autoplay: true,
        pip: true,
        autoSize: false,
        autoMini: false,
        screenshot: false,
        setting: true,
        loop: false,
        flip: false,
        playbackRate: false,
        aspectRatio: false,
        fullscreen: true,
        fullscreenWeb: true,
        subtitleOffset: false,
        miniProgressBar: false,
        mutex: true,
        playsInline: true,
        autoPlayback: false,
        airplay: false,
        theme: '#60a5fa',
        lang: 'zh-cn',
        hotkey: false,
        // 内置长按加速仅移动端生效且倍率不可配，这里关闭，改用统一的自定义实现（触摸 + 鼠标，固定 3 倍速）
        fastForward: false,
        autoOrientation: true,
        lock: true,
        moreVideoAttr: {
          crossOrigin: 'anonymous',
        },
        plugins: [],
        // HLS 支持配置
        customType: {
          m3u8: function (video: HTMLVideoElement, url: string) {
            if (!Hls) {
              console.error('HLS.js 未加载');
              return;
            }

            class CustomHlsJsLoader extends Hls.DefaultConfig.loader {
              constructor(config: any) {
                super(config);
                const load = this.load.bind(this);
                this.load = function (context: any, config: any, callbacks: any) {
                  // 拦截manifest和level请求
                  if (
                    (context as any).type === 'manifest' ||
                    (context as any).type === 'level'
                  ) {
                    const onSuccess = callbacks.onSuccess;
                    callbacks.onSuccess = function (
                      response: any,
                      stats: any,
                      context: any
                    ) {
                      // 如果是m3u8文件，处理内容以移除广告分段
                      if (response.data && typeof response.data === 'string') {
                        // 过滤掉广告段 - 实现更精确的广告过滤逻辑
                        response.data = filterAdsFromM3U8(response.data);
                      }
                      return onSuccess(response, stats, context, null);
                    };
                  }
                  // 执行原始load方法
                  load(context, config, callbacks);
                };
              }
            }

            if (video.hls) {
              video.hls.destroy();
            }
            const hls = new Hls({
              debug: false, // 关闭日志
              enableWorker: true, // WebWorker 解码，降低主线程压力
              lowLatencyMode: true, // 开启低延迟 LL-HLS

              /* 缓冲/内存相关 - 极致流畅版 */
              maxBufferLength: 80, // 前向缓冲最大 80s，过大容易导致高延迟
              maxMaxBufferLength: 200, // 设置一个安全的最大上限，防止意外的缓冲裁剪
              backBufferLength: 40, // 仅保留 40s 已播放内容，避免内存占用
              maxBufferSize: 500 * 1000 * 1000, // 约 500MB，超出后触发清理

              /* 自定义loader */
              loader: blockAdEnabledRef.current
                ? CustomHlsJsLoader
                : Hls.DefaultConfig.loader,
            });

            hls.loadSource(url);
            hls.attachMedia(video);
            artPlayerRef.current.hls = hls; // 附加到 Artplayer 实例
            video.hls = hls; // 保留现有 video.hls 引用（如果存在）

            ensureVideoSource(video, url);

            hls.on(Hls.Events.ERROR, function (event: any, data: any) {
              console.error('HLS Error:', event, data);
              if (data.fatal) {
                switch (data.type) {
                  case Hls.ErrorTypes.NETWORK_ERROR:
                    console.log('网络错误，尝试恢复...');
                    hls.startLoad();
                    break;
                  case Hls.ErrorTypes.MEDIA_ERROR:
                    console.log('媒体错误，尝试恢复...');
                    hls.recoverMediaError();
                    break;
                  default:
                    console.log('无法恢复的错误');
                    hls.destroy();
                    break;
                }
              }
            });
          },
        },
        icons: {
          loading: '<img src="/assets/img/ploading.gif">',
          state: '<img width="100" src="/assets/img/state.svg">',
        },
        settings: [
          {
            html: '拦截广告',
            icon: '<text x="50%" y="50%" font-size="20" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#ffffff">AD</text>',
            tooltip: blockAdEnabled ? '已开启' : '已关闭',
            onClick() {
              const newVal = !blockAdEnabled;
              try {
                localStorage.setItem('enable_blockad', String(newVal));
                if (artPlayerRef.current) {
                  resumeTimeRef.current = artPlayerRef.current.currentTime;
                  if (
                    artPlayerRef.current.video &&
                    artPlayerRef.current.video.hls
                  ) {
                    artPlayerRef.current.video.hls.destroy();
                  }
                  artPlayerRef.current.destroy();
                  artPlayerRef.current = null;
                }
                setBlockAdEnabled(newVal);
              } catch (_){
                // ignore
              }
              return newVal ? '当前开启' : '当前关闭';
            },
          },
          {
            name: '跳过片头片尾',
            html: '跳过片头片尾',
            switch: skipConfigRef.current.enable,
            onSwitch: function (item: { switch: boolean }) {
              const newConfig = {
                ...skipConfigRef.current,
                enable: !item.switch,
              };
              handleSkipConfigChange(newConfig);
              return !item.switch;
            },
          },
          {
            html: '删除跳过配置',
            onClick: function () {
              handleSkipConfigChange({
                enable: false,
                intro_time: 0,
                outro_time: 0,
              });
              return '';
            },
          },
          {
            name: '设置片头',
            html: '设置片头',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="12" r="2" fill="#ffffff"/><path d="M9 12L17 12" stroke="#ffffff" stroke-width="2"/><path d="M17 6L17 18" stroke="#ffffff" stroke-width="2"/></svg>',
            tooltip:
              skipConfigRef.current.intro_time === 0
                ? '设置片头时间'
                : `${formatTime(skipConfigRef.current.intro_time)}`,
            onClick: function () {
              const currentTime = artPlayerRef.current?.currentTime || 0;
              if (currentTime > 0) {
                const newConfig = {
                  ...skipConfigRef.current,
                  intro_time: currentTime,
                };
                handleSkipConfigChange(newConfig);
                return `${formatTime(currentTime)}`;
              }
            },
          },
          {
            name: '设置片尾',
            html: '设置片尾',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 6L7 18" stroke="#ffffff" stroke-width="2"/><path d="M7 12L15 12" stroke="#ffffff" stroke-width="2"/><circle cx="19" cy="12" r="2" fill="#ffffff"/></svg>',
            tooltip:
              skipConfigRef.current.outro_time >= 0
                ? '设置片尾时间'
                : `-${formatTime(-skipConfigRef.current.outro_time)}`,
            onClick: function () {
              const outroTime =
                -(artPlayerRef.current?.duration - artPlayerRef.current?.currentTime) || 0;
              if (outroTime < 0) {
                const newConfig = {
                  ...skipConfigRef.current,
                  outro_time: outroTime,
                };
                handleSkipConfigChange(newConfig);
                return `-${formatTime(-outroTime)}`;
              }
            },
          },
        ],
        

        // 控制栏配置
        controls: [
          {
            position: 'left',
            index: 13,
            html: '<i class="art-icon flex"><svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" fill="currentColor"/></svg></i>',
            tooltip: '播放下一集',
            click: function () {
              handleNextEpisode();
            },
          },
          {
            name: 'playback-rate',
            position: 'right',
            index: 20,
            html: `<b>${formatPlaybackRateText(playbackRateRef.current)}</b>`,
            selector: getPlaybackRateSelector(),
            onSelect: function(item: PlaybackRateSelector){
              // 记录并持久化，跳转下一集 / 重进页面都保持
              applyUserPlaybackRate(item.value);
              applyPlaybackRateToPlayer(item.value);
              return `<b>${formatPlaybackRateText(item.value)}</b>`
            }
          }
        ],
      });

      // 新建播放器后立即套用用户设定的倍速（首帧就生效，避免先 1x 再跳变）
      applyPlaybackRateToPlayer(playbackRateRef.current);
      // 更新音量调节位置
      artPlayerRef.current.controls.update({
        name: 'volume',
        position: 'right',
        index: 30
      });

      // 监听网页全屏事件
      artPlayerRef.current.on('fullscreenWeb', (isWebFullscreen: boolean) => {
        if (artRef.current) {
          if (isWebFullscreen) {
            artRef.current.classList.add('is-web-fullscreen');
          } else {
            artRef.current.classList.remove('is-web-fullscreen');
          }
        }
      });

      // 监听播放器事件
      artPlayerRef.current.on('ready', () => {
        setError(null);

        // 播放器就绪后，如果正在播放则请求 Wake Lock
        if (artPlayerRef.current && !artPlayerRef.current.paused) {
          requestWakeLock();
        }
      });

      // 监听播放状态变化，控制 Wake Lock
      artPlayerRef.current.on('play', () => {
        requestWakeLock();
      });

      artPlayerRef.current.on('pause', () => {
        releaseWakeLock();
        saveCurrentPlayProgress();
      });

      artPlayerRef.current.on('video:ended', () => {
        releaseWakeLock();
      });

      // 如果播放器初始化时已经在播放状态，则请求 Wake Lock
      if (artPlayerRef.current && !artPlayerRef.current.paused) {
        requestWakeLock();
      }

      artPlayerRef.current.on('video:volumechange', () => {
        lastVolumeRef.current = artPlayerRef.current.volume;
      });

      // 注意：这里**不要**监听 video:ratechange 去"学习"用户偏好。
      // 切集 / 换源时 artplayer 会重新加载媒体，浏览器把 playbackRate 重置为
      // defaultPlaybackRate（1.0）并触发 ratechange —— 如果把这个重置当成用户意图，
      // 会把用户设定的倍速覆盖成 1，表现为"切下一集后倍速丢了"。
      // 用户的速率入口只有控制栏选择器（onSelect）与本地恢复，均已显式处理。

      // 监听视频可播放事件，这时恢复播放进度更可靠
      artPlayerRef.current.on('video:canplay', () => {
        // 若存在需要恢复的播放进度，则跳转
        if (resumeTimeRef.current && resumeTimeRef.current > 0) {
          try {
            const duration = artPlayerRef.current.duration || 0;
            let target = resumeTimeRef.current;
            if (duration && target >= duration - 2) {
              target = Math.max(0, duration - 5);
            }
            artPlayerRef.current.currentTime = target;
            console.log('成功恢复播放进度到:', resumeTimeRef.current);
          } catch (err) {
            console.warn('恢复播放进度失败:', err);
          }
        }
        resumeTimeRef.current = null;

        setTimeout(() => {
          if (
            Math.abs(artPlayerRef.current.volume - lastVolumeRef.current) > 0.01
          ) {
            artPlayerRef.current.volume = lastVolumeRef.current;
          }
          // 保持用户设定的倍速：无论 WebKit 还是其他内核，切集/换源后都恢复。
          // 但**长按加速期间要跳过** —— hls 缓冲波动会让 canplay 反复触发，
          // 若不跳过就会把长按中的 3x 又拽回用户倍速。
          if (
            !longPressRateActiveRef.current &&
            Math.abs(
              artPlayerRef.current.playbackRate - playbackRateRef.current
            ) > 0.001
          ) {
            applyPlaybackRateToPlayer(playbackRateRef.current);
          }
          artPlayerRef.current.notice.show = '';
        }, 0);

        // 隐藏路线加载状态
        setIsVideoLoading(false);
      });

      // 监听视频时间更新事件，实现跳过片头片尾
      artPlayerRef.current.on('video:timeupdate', () => {
        if (!skipConfigRef.current.enable) return;

        const currentTime = artPlayerRef.current.currentTime || 0;
        const duration = artPlayerRef.current.duration || 0;
        const now = Date.now();

        // 限制跳过检查频率为1.5秒一次
        if (now - lastSkipCheckRef.current < 1500) return;
        lastSkipCheckRef.current = now;

        // 跳过片头
        if (
          skipConfigRef.current.intro_time > 0 &&
          currentTime < skipConfigRef.current.intro_time
        ) {
          artPlayerRef.current.currentTime = skipConfigRef.current.intro_time;
          artPlayerRef.current.notice.show = `已跳过片头 (${formatTime(
            skipConfigRef.current.intro_time
          )})`;
        }

        // 跳过片尾
        if (
          skipConfigRef.current.outro_time < 0 &&
          duration > 0 &&
          currentTime >
            artPlayerRef.current.duration + skipConfigRef.current.outro_time
        ) {
          if (
            currentEpisodeIndexRef.current <
            (detailRef.current?.episodes?.length || 1) - 1
          ) {
            handleNextEpisode();
          } else {
            artPlayerRef.current.pause();
          }
          artPlayerRef.current.notice.show = `已跳过片尾 (${formatTime(
            skipConfigRef.current.outro_time
          )})`;
        }
      });

      artPlayerRef.current.on('error', (err: any) => {
        console.error('播放器错误:', err);
        if (artPlayerRef.current.currentTime > 0) {
          return;
        }
      });

      // 监听视频播放结束事件，自动播放下一集
      artPlayerRef.current.on('video:ended', () => {
        const d = detailRef.current;
        const idx = currentEpisodeIndexRef.current;
        if (d && d.episodes && idx < d.episodes.length - 1) {
          setTimeout(() => {
            setCurrentEpisodeIndex(idx + 1);
          }, 1000);
        }
      });

      artPlayerRef.current.on('video:timeupdate', () => {
        const now = Date.now();
        let interval = 5000;
        if (process.env.NEXT_PUBLIC_STORAGE_TYPE === 'upstash') {
          interval = 20000;
        }
        if (now - lastSaveTimeRef.current > interval) {
          saveCurrentPlayProgress();
          lastSaveTimeRef.current = now;
        }
      });

      artPlayerRef.current.on('pause', () => {
        saveCurrentPlayProgress();
      });

      if (artPlayerRef.current?.video) {
        ensureVideoSource(
          artPlayerRef.current.video as HTMLVideoElement,
          videoUrl
        );
      }
    } catch (err) {
      console.error('创建播放器失败:', err);
      setError('播放器初始化失败');
    }
  }, [Artplayer, Hls, videoUrl, loading, blockAdEnabled]);

  // ---------------------------------------------------------------------------
  // 播放器区域：屏蔽长按产生的「选字 / 放大镜 / 系统长按菜单」
  //
  // 样式层面已在 globals.css 的 `.jf-player *` 里禁用了选择与 touch-callout；
  // 这里再拦一层事件，覆盖那些无视 CSS 的内核（部分国产内核浏览器会自己弹
  // 「选择文字 / 复制 / 拖动」菜单，与 CSS 无关）。
  //
  // 只拦 contextmenu / selectstart / dragstart —— **不拦 touchstart**：
  // artplayer 的单击播放/暂停依赖 <video> 的 click，iOS 上被 preventDefault 的
  // touchstart 不会再生成 click，拦了就会出现「点画面不暂停」的回归。
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const container = artRef.current;
    if (!container) return;

    const blockEvent = (event: Event) => {
      event.preventDefault();
    };

    container.addEventListener('contextmenu', blockEvent);
    container.addEventListener('selectstart', blockEvent);
    container.addEventListener('dragstart', blockEvent);

    return () => {
      container.removeEventListener('contextmenu', blockEvent);
      container.removeEventListener('selectstart', blockEvent);
      container.removeEventListener('dragstart', blockEvent);
    };
  }, [loading, error]);

  // ---------------------------------------------------------------------------
  // 长按画面 3 倍速播放（触摸 / 鼠标通用，主流播放器交互）
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const container = artRef.current;
    if (!container) return;

    // 长按加速是否可用。
    // 注意：不能直接用 `art.playing` —— 它的实现是
    // `!video.paused && video.readyState > 2 && !video.ended`，
    // 缓冲不足时 readyState 会掉到 HAVE_FUTURE_DATA 以下，`playing` 瞬时变 false，
    // 表现为"同一个长按操作有时生效、有时没反应"（弱网下尤甚）。
    // 这里只要求「未暂停且未结束」，与画面是否刚好缓冲完无关。
    const isRunning = () => {
      const art = artPlayerRef.current;
      const video = art?.video as HTMLVideoElement | undefined;
      if (!art || !video) return false;
      if (art.isLock) return false;
      return !video.paused && !video.ended;
    };

    // 判断按压点是否落在播放器控件上。
    //
    // 为什么不用 `event.target.closest(...)`：artplayer 的 `.art-bottom` 是一个
    // 覆盖整个播放器区域的绝对定位容器（实测 rect ≈ 整个播放器），按 DOM 层级判断会
    // 把「画面正中央」也误判成控制栏；而按坐标比较矩形同样会被这个全屏容器带偏。
    //
    // `document.elementsFromPoint` 会**忽略 `pointer-events: none` 的层**，
    // 返回的正是用户实际"点到"的元素栈，因此能准确区分「点在画面上」与「点在控件上」。
    const CONTROL_SELECTOR =
      '.art-controls, .art-progress, .art-settings, .art-contextmenus, .art-volume-panel, .art-notice, .art-auto-playback-last';

    const isOnControls = (x: number, y: number) => {
      const stack = document.elementsFromPoint(x, y);
      return stack.some(el => (el as Element).closest?.(CONTROL_SELECTOR));
    };

    const clearLongPressTimer = () => {
      if (longPressRateTimerRef.current) {
        clearTimeout(longPressRateTimerRef.current);
        longPressRateTimerRef.current = null;
      }
    };

    const stopLongPressRace = () => {
      clearLongPressTimer();
      if (!longPressRateActiveRef.current) return;

      longPressRateActiveRef.current = false;
      setIsLongPressRacing(false);

      // 恢复到用户设定的倍速
      const art = artPlayerRef.current;
      if (art) {
        try {
          const video = art.video as HTMLVideoElement | undefined;
          if (video) video.playbackRate = playbackRateRef.current;
        } catch (_) {
          // ignore
        }
      }

      // 长按结束浏览器仍可能补发 click，拦截一次避免误触播放/暂停
      suppressVideoClickRef.current = true;
      setTimeout(() => {
        suppressVideoClickRef.current = false;
      }, 300);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (!isRunning()) return;

      // 落在控制栏 / 设置面板 / 进度条等控件上的按压不算长按加速
      if (isOnControls(event.clientX, event.clientY)) return;

      clearLongPressTimer();
      longPressRateTimerRef.current = setTimeout(() => {
        if (longPressRateActiveRef.current) return;
        if (!isRunning()) return;

        longPressRateActiveRef.current = true;
        setIsLongPressRacing(true);
        try {
          const video = artPlayerRef.current?.video as
            | HTMLVideoElement
            | undefined;
          if (video) video.playbackRate = LONG_PRESS_RATE;
        } catch (_) {
          // ignore
        }
      }, LONG_PRESS_DELAY);
    };

    const handlePointerEnd = () => {
      stopLongPressRace();
    };

    const handleClickCapture = (event: MouseEvent) => {
      if (suppressVideoClickRef.current) {
        event.stopPropagation();
        event.preventDefault();
        suppressVideoClickRef.current = false;
      }
    };

    container.addEventListener('pointerdown', handlePointerDown);
    container.addEventListener('pointerup', handlePointerEnd);
    container.addEventListener('pointercancel', handlePointerEnd);
    container.addEventListener('pointerleave', handlePointerEnd);
    container.addEventListener('click', handleClickCapture, true);

    return () => {
      container.removeEventListener('pointerdown', handlePointerDown);
      container.removeEventListener('pointerup', handlePointerEnd);
      container.removeEventListener('pointercancel', handlePointerEnd);
      container.removeEventListener('pointerleave', handlePointerEnd);
      container.removeEventListener('click', handleClickCapture, true);
      clearLongPressTimer();
      if (longPressRateActiveRef.current) {
        longPressRateActiveRef.current = false;
        setIsLongPressRacing(false);
      }
    };
  }, [loading, error]);

  

  // 当组件卸载时清理定时器、Wake Lock 和播放器资源
  useEffect(() => {
    return () => {
      // 清理定时器
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
      }

      // 释放 Wake Lock
      releaseWakeLock();

      // 销毁播放器实例
      cleanupPlayer();
    };
  }, []);

  if (loading) {
    return (
      <PageLayout activePath='/play'>
        <div className='flex items-center justify-center min-h-[calc(100vh-3rem)] md:min-h-screen bg-transparent overflow-hidden md:overflow-visible'>
          <div className='text-center max-w-md mx-auto px-6 transform -translate-y-16 md:-translate-y-4'>
            {/* New Animation */}
            <div className="wrapper">
                {/* 茶包 */}
                <div className="teabag">
                    {/* 茶包顶部 */}
                    <div className="teabag-top"></div>
                    {/* 茶包身体 */}
                    <div className="teabag-body">
                        <div className="teabag-content">
                            <div className="teabag-eyes eyes">
                                <div className="teabag-eye eye"></div>
                                <div className="teabag-eye eye"></div>
                            </div>
                            <div className="teabag-mouth"></div>
                        </div>
                    </div>
                    {/* 茶包孔 */}
                    <div className="teabag-pores">
                        <span className="teabag-pore"></span>
                        <span className="teabag-pore"></span>
                        <span className="teabag-pore"></span>
                        <span className="teabag-pore"></span>
                        <span className="teabag-pore"></span>
                        <span className="teabag-pore"></span>
                        <span className="teabag-pore"></span>
                        <span className="teabag-pore"></span>
                        <span className="teabag-pore"></span>
                        <span className="teabag-pore"></span>
                        <span className="teabag-pore"></span>
                        <span className="teabag-pore"></span>
                        <span className="teabag-pore"></span>
                        <span className="teabag-pore"></span>
                    </div>
                </div>
                {/* 茶杯 */}
                <div className="cup">
                    {/* 杯子 */}
                    <div className="cup-body">
                        <div className="cup-eyes eyes">
                            <div className="cup-eye eye"></div>
                            <div className="cup-eye eye"></div>
                        </div>
                        <div className="cup-mouth">
                            <div className="cup-tongue"></div>
                        </div>
                    </div>
                    {/* 杯柄 */}
                    <div className="cup-handle"></div>
                    {/* 杯碟 */}
                    <div className="cup-saucer">
                        <div className="cup-saucer-top"></div>
                        <div className="cup-saucer-bottom"></div>
                    </div>
                </div>
            </div>

            {/* 进度指示器 */}
            <div className='-mt-8 mb-6 w-80 mx-auto'>
              <div className='flex justify-center space-x-2 mb-4'>
                <div
                  className={`w-3 h-3 rounded-full transition-all duration-500 ${ 
                    loadingStage === 'searching' || loadingStage === 'fetching'
                      ? 'bg-joyflix-blue scale-125'
                      : loadingStage === 'preferring' ||
                        loadingStage === 'ready'
                      ? 'bg-joyflix-blue'
                      : 'bg-gray-200'
                  }`}
                ></div>
                <div
                  className={`w-3 h-3 rounded-full transition-all duration-500 ${ 
                    loadingStage === 'preferring'
                      ? 'bg-joyflix-blue scale-125'
                      : loadingStage === 'ready'
                      ? 'bg-joyflix-blue'
                      : 'bg-gray-200'
                  }`}
                ></div>
                <div
                  className={`w-3 h-3 rounded-full transition-all duration-500 ${ 
                    loadingStage === 'ready'
                      ? 'bg-joyflix-blue scale-125'
                      : 'bg-gray-200'
                  }`}
                ></div>
              </div>

              {/* 进度条 */}
              <div className='w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden'>
                <div
                  className='h-full bg-gradient-to-r from-joyflix-blue to-joyflix-blue-dark rounded-full transition-all duration-1000 ease-out'
                  style={{
                    width:
                      loadingStage === 'searching' ||
                      loadingStage === 'fetching'
                        ? '33%'
                        : loadingStage === 'preferring'
                        ? '66%'
                        : '100%',
                  }}
                ></div>
              </div>
            </div>

            {/* 加载消息 */}
            <div className='space-y-2'>
              <p className='text-xl font-semibold text-gray-800 dark:text-gray-200 animate-pulse'>
                {loadingMessage}
              </p>
            </div>
          </div>
        </div>
      </PageLayout>
    );
  }

  if (error) {
    return (
      <PageLayout activePath='/play'>
        <div className='flex items-center justify-center min-h-screen bg-transparent'>
          <div className='text-center max-w-md mx-auto px-6'>
            {/* 错误图标 */}
            <div className='relative mb-8'>
              <div className='relative mx-auto w-24 h-24 bg-gradient-to-r from-red-500 to-orange-500 rounded-2xl shadow-2xl flex items-center justify-center transform hover:scale-105 transition-transform duration-300'>
                <div className='text-white text-4xl'>😵</div>
                {/* 脉冲效果 */}
                <div className='absolute -inset-2 bg-gradient-to-r from-red-500 to-orange-500 rounded-2xl opacity-20 animate-pulse'></div>
              </div>

              {/* 浮动错误粒子 */}
              <div className='absolute top-0 left-0 w-full h-full pointer-events-none'>
                <div className='absolute top-2 left-2 w-2 h-2 bg-red-400 rounded-full animate-bounce'></div>
                <div
                  className='absolute top-4 right-4 w-1.5 h-1.5 bg-orange-400 rounded-full animate-bounce'
                  style={{ animationDelay: '0.5s' }}
                ></div>
                <div
                  className='absolute bottom-3 left-6 w-1 h-1 bg-yellow-400 rounded-full animate-bounce'
                  style={{ animationDelay: '1s' }}
                ></div>
              </div>
            </div>

            {/* 错误信息 */}
            <div className='space-y-4 mb-8'>
              <h2 className='text-2xl font-bold text-gray-800 dark:text-gray-200'>
                出现了一些问题
              </h2>
              <div className='bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4'>
                <p className='text-red-600 dark:text-red-400 font-medium'> 
                  {error}
                </p>
              </div>
            </div>

            {/* 操作按钮 */}
            <div className='space-y-3'>
              <button
                onClick={() =>
                  videoTitle
                    ? router.push(`/search?q=${encodeURIComponent(videoTitle)}`)
                    : router.back()
                }
                className='w-full px-6 py-3 bg-gradient-to-r from-blue-400 to-blue-500 text-white rounded-xl font-medium hover:from-blue-400 hover:to-blue-600 transform hover:scale-105 transition-all duration-200 shadow-lg hover:shadow-xl'
              >
                {videoTitle ? '返回搜索' : '返回上页'}
              </button>

              <button
                onClick={() => window.location.reload()}
                className='w-full px-6 py-3 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-xl font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors duration-200'
              >
                重新尝试
              </button>
            </div>
          </div>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout 
      activePath='/play'
      headerContent={
        <h1 className='text-xl font-semibold text-gray-900 dark:text-gray-100 ml-4'>
          {videoTitle || '影片标题'}
          {totalEpisodes > 1 && (
            <span className='text-gray-500 dark:text-gray-400'>
              {` > 第 ${currentEpisodeIndex + 1} 集`}
            </span>
          )}
        </h1>
      }
    >
      <div className='flex flex-col gap-3 py-4 px-5 lg:px-[3rem] 2xl:px-20'>
        {/* 第一行：影片标题 */}
        <div className='py-1'>
          <h1 className='text-xl font-semibold text-gray-900 dark:text-gray-100 md:invisible'>
            {videoTitle || '影片标题'}
            {totalEpisodes > 1 && (
              <span className='text-gray-500 dark:text-gray-400'>
                {` > 第 ${currentEpisodeIndex + 1} 集`}
              </span>
            )}
          </h1>
        </div>
        {/* 第二行：播放器和集数 */}
        <div className='space-y-2'>
          
          

          <div
            className={`grid gap-4 lg:h-[500px] xl:h-[650px] 2xl:h-[750px] transition-all duration-300 ease-in-out grid-cols-1 md:grid-cols-4`}
          >
            {/* 播放器 */}
            <div
              className={`h-full transition-all duration-300 ease-in-out rounded-xl border border-white/0 dark:border-white/30 md:col-span-3`}
            >
              <div className='relative w-full h-[300px] lg:h-full'>
                <div
                  ref={artRef}
                  className='jf-player bg-black w-full h-full rounded-xl overflow-hidden shadow-lg'
                  style={{
                    WebkitTouchCallout: 'none',
                    WebkitUserSelect: 'none',
                    userSelect: 'none',
                  }}
                ></div>

                {/* 长按画面 3 倍速播放提示 */}
                {isLongPressRacing && (
                  <div className='pointer-events-none absolute inset-0 z-30 flex items-center justify-center'>
                    <div className='animate-fade-in flex items-center gap-2 rounded-full bg-black/70 px-5 py-2.5 text-white shadow-lg backdrop-blur-sm'>
                      <svg
                        width='20'
                        height='20'
                        viewBox='0 0 24 24'
                        fill='currentColor'
                        xmlns='http://www.w3.org/2000/svg'
                      >
                        <path d='M4 5.5v13a1 1 0 0 0 1.53.85l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 4 5.5z' />
                        <path d='M17 5.5v13a1 1 0 0 0 2 0v-13a1 1 0 0 0-2 0z' />
                      </svg>
                      <span className='text-lg font-bold leading-none'>
                        {LONG_PRESS_RATE}x
                      </span>
                      <span className='text-sm opacity-90'>快进中</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 集数和路线 */}
            <div
              className={`relative h-[300px] lg:h-full md:overflow-hidden transition-all duration-300 ease-in-out md:col-span-1 lg:opacity-100 lg:scale-100`}
            >
              {longPressedTitle && (
                <div className={`absolute top-0 left-0 right-0 z-20 p-2 bg-gray-800/90 text-white text-center text-sm shadow-lg ${isFadingOut ? 'animate-fade-out' : 'animate-fade-in-down'}`}>
                  {longPressedTitle}
                </div>
              )}
              <EpisodeSelector
                totalEpisodes={totalEpisodes}
                episodes_titles={detail?.episodes_titles || []}
                value={currentEpisodeIndex + 1}
                onChange={handleEpisodeChange}
                onLongPress={handleLongPress}
                onSourceChange={handleSourceChange}
                currentSource={currentSource}
                currentId={currentId}
                videoTitle={searchTitle || videoTitle}
                availableSources={availableSources}
                sourceSearchLoading={sourceSearchLoading}
                sourceSearchError={sourceSearchError}
                precomputedVideoInfo={precomputedVideoInfo}
              />
            </div>
          </div>
        </div>

        {/* 详情展示 */}
        <div className='grid grid-cols-1 md:grid-cols-4 gap-4'>
          {/* 文字区 */}
          <div className='md:col-span-3'>
            <div className='p-6 flex flex-col min-h-0'>
              {/* 标题 */}
              <h1 className='text-3xl font-bold mb-2 tracking-wide flex items-center flex-shrink-0 text-center md:text-left w-full'>
                {videoTitle || '影片标题'}
                
              </h1>

              {/* 关键信息行 */}
              <div className='flex flex-wrap items-center gap-x-2 gap-y-1 text-sm mb-4 text-gray-600 dark:text-gray-300 flex-shrink-0'>
                {/* 年份 (Year) - First */}
                {(detail?.year || videoYear) && (
                  <>
                    <span className='border border-gray-500/60 px-2 py-[1px] rounded'>
                      {detail?.year || videoYear}
                    </span>
                  </>
                )}

                {/* 分类 (Class) - Second */}
                {detail?.class && (
                  <>
                    <span className='border border-gray-500/60 px-2 py-[1px] rounded'>
                      {detail.class}
                    </span>
                  </>
                )}

                {/* 类型名称 (Type Name) - Fourth */}
                {detail?.type_name && (
                  <>
                    <span className='border border-gray-500/60 px-2 py-[1px] rounded'>
                      {detail.type_name}
                    </span>
                  </>
                )}

                {/* 来源名称 (Source Name) - Third */}
                {detail?.source_name && (
                  <span className='border border-gray-500/60 px-2 py-[1px] rounded'>
                    {detail.source_name}
                  </span>
                )}
              </div>
              {/* 剧情简介 */}
              {detail?.desc && (
                <div
                  className='mt-0 text-base leading-relaxed opacity-90 overflow-y-auto pr-2 flex-1 min-h-0 scrollbar-hide'
                  style={{ whiteSpace: 'pre-line' }}
                >
                  {detail.desc}
                </div>
              )}
            </div>
          </div>

          {/* 封面展示 */}
          <div className='hidden md:block md:col-span-1 md:order-first'>
            <div className='pl-0 py-4 pr-6'>
              <div className='relative bg-gray-300 dark:bg-gray-700 aspect-[2/3] flex items-center justify-center rounded-xl overflow-hidden'>
                {videoCover ? (
                  <>
                    <img
                      src={processImageUrl(videoCover)}
                      alt={videoTitle}
                      className='w-full h-full object-cover'
                    />

                    
                  </>
                ) : (
                  <span className='text-gray-600 dark:text-gray-400'>
                    封面图片
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}



export default function PlayPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PlayPageClient />
    </Suspense>
  );
}
