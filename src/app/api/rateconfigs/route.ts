/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { PlaybackRateConfig } from '@/lib/types';

export const runtime = 'edge';

// 合法的倍速范围（客户端目前提供 0.5 ~ 2.0，这里放宽一档以便后续扩展）
const MIN_RATE = 0.25;
const MAX_RATE = 4;

export async function GET(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    const config = await getConfig();
    if (config.UserConfig.Users) {
      // 检查用户是否被封禁
      const user = config.UserConfig.Users.find(
        (u) => u.username === authInfo.username
      );
      if (user && user.banned) {
        return NextResponse.json({ error: '用户已被封禁' }, { status: 401 });
      }
    }

    const { searchParams } = new URL(request.url);
    const source = searchParams.get('source');
    const id = searchParams.get('id');

    if (source && id) {
      // 获取单个配置
      const rateConfig = await db.getPlaybackRateConfig(
        authInfo.username,
        source,
        id
      );
      return NextResponse.json(rateConfig);
    }

    // 获取所有配置
    const configs = await db.getAllPlaybackRateConfigs(authInfo.username);
    return NextResponse.json(configs);
  } catch (error) {
    console.error('获取播放倍速配置失败:', error);
    return NextResponse.json({ error: '获取播放倍速配置失败' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    const adminConfig = await getConfig();
    if (adminConfig.UserConfig.Users) {
      // 检查用户是否被封禁
      const user = adminConfig.UserConfig.Users.find(
        (u) => u.username === authInfo.username
      );
      if (user && user.banned) {
        return NextResponse.json({ error: '用户已被封禁' }, { status: 401 });
      }
    }

    const body = await request.json();
    const { key, config } = body;

    if (!key || !config) {
      return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
    }

    // 解析key为source和id
    const [source, ...rest] = String(key).split('+');
    const id = rest.join('+');
    if (!source || !id) {
      return NextResponse.json({ error: '无效的key格式' }, { status: 400 });
    }

    // 验证配置格式
    const rate = Number(config.rate);
    if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
      return NextResponse.json({ error: '无效的播放倍速' }, { status: 400 });
    }

    const rateConfig: PlaybackRateConfig = { rate };

    await db.setPlaybackRateConfig(authInfo.username, source, id, rateConfig);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('保存播放倍速配置失败:', error);
    return NextResponse.json({ error: '保存播放倍速配置失败' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    const adminConfig = await getConfig();
    if (adminConfig.UserConfig.Users) {
      // 检查用户是否被封禁
      const user = adminConfig.UserConfig.Users.find(
        (u) => u.username === authInfo.username
      );
      if (user && user.banned) {
        return NextResponse.json({ error: '用户已被封禁' }, { status: 401 });
      }
    }

    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');

    if (!key) {
      return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
    }

    // 解析key为source和id
    const [source, ...rest] = String(key).split('+');
    const id = rest.join('+');
    if (!source || !id) {
      return NextResponse.json({ error: '无效的key格式' }, { status: 400 });
    }

    await db.deletePlaybackRateConfig(authInfo.username, source, id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('删除播放倍速配置失败:', error);
    return NextResponse.json({ error: '删除播放倍速配置失败' }, { status: 500 });
  }
}
