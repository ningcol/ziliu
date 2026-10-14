import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { z } from 'zod';

// Keep the existing authenticated request contract for compatibility.
// Platform publishing is performed through the editor/browser-extension flow,
// not by any implemented server-side provider in this route.
const publishSchema = z.object({
  title: z.string().min(1, '标题不能为空'),
  content: z.string().min(1, '内容不能为空'),
  platform: z.enum(['wechat', 'zhihu', 'juejin', 'zsxq']),
  settings: z.object({
    id: z.string(),
    name: z.string(),
    platform: z.string(),
    isDefault: z.boolean(),
    authorName: z.string().optional(),
    headerContent: z.string().optional(),
    footerContent: z.string().optional(),
    platformConfig: z.any().optional(),
  }),
});

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json(
        { success: false, error: '未授权访问' },
        { status: 401 }
      );
    }

    const body = await request.json();
    publishSchema.parse(body);

    // None of the four server-side publishing implementations existed here.
    // A synthetic "success" / URL cannot prove that a platform received a post.
    // Explicitly refuse all valid server-side publishing requests until a
    // separately authorized and verifiable integration is implemented.
    return NextResponse.json(
      {
        success: false,
        error: '服务端直接发布尚未实现，请通过浏览器插件前往目标平台发布',
      },
      { status: 501 }
    );
  } catch (error) {
    console.error('Publish error:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: error.issues?.[0]?.message || '参数错误' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '发布失败',
      },
      { status: 500 }
    );
  }
}
