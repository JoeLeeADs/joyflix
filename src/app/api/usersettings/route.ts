/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';

export const runtime = 'edge';

// 允许读写的设置键白名单（避免变成任意 KV 写入口）。
// 长按倍速：可选 1.5 / 2 / 2.5 / 3（与播放页设置面板的选项一致）。
const ALLOWED_KEYS: Record<string, string[]> = {
  longPressRate: ['1.5', '2', '2.5', '3'],
};

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
    const key = searchParams.get('key');
    if (!key || !ALLOWED_KEYS[key]) {
      return NextResponse.json({ error: '不支持的设置键' }, { status: 400 });
    }

    const value = await db.getUserSetting(authInfo.username, key);
    return NextResponse.json({ key, value });
  } catch (error) {
    console.error('获取用户设置失败:', error);
    return NextResponse.json({ error: '获取用户设置失败' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
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

    const body = await request.json();
    const { key, value } = body || {};
    if (!key || value === undefined || value === null) {
      return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
    }
    if (!ALLOWED_KEYS[key]) {
      return NextResponse.json({ error: '不支持的设置键' }, { status: 400 });
    }

    const strValue = String(value);
    if (!ALLOWED_KEYS[key].includes(strValue)) {
      return NextResponse.json({ error: '无效的设置值' }, { status: 400 });
    }

    await db.setUserSetting(authInfo.username, key, strValue);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('保存用户设置失败:', error);
    return NextResponse.json({ error: '保存用户设置失败' }, { status: 500 });
  }
}
