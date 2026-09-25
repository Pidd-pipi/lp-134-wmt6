import { Router } from 'express';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from '../config/prisma.js';
import { authMiddleware, optionalAuthMiddleware, AuthRequest } from '../middleware/auth.middleware.js';
import { sendInternalError, sendValidationError } from '../utils/httpResponses.js';

const router = Router();

const createGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1),
  topic: z.string().min(1),
  maxMembers: z.number().min(3).max(5).default(5),
  meetingTime: z.string().optional(),
  meetingFrequency: z.string().optional()
});

const createMessageSchema = z.object({
  content: z.string().min(1)
});

const createCheckInSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  reminderTime: z.string().min(1)
});

const submitCheckInSchema = z.object({
  status: z.enum(['COMPLETED', 'MISSED']),
  response: z.string().optional(),
  moodRating: z.number().min(1).max(10).optional()
});

const leaveGroupSchema = z.object({
  reason: z.string().min(1, '退出原因不能为空').max(500)
});

const removeWaitlistSchema = z.object({
  reason: z.string().max(500).optional()
});

const memberUserSelect = {
  id: true,
  username: true,
  nickname: true,
  avatar: true
};

// 成员退出后把最早的候补者递补为正式成员（须在事务中调用）
const promoteNextWaitlisted = async (
  tx: Prisma.TransactionClient,
  groupId: string
) => {
  const nextEntry = await tx.groupWaitlistEntry.findFirst({
    where: { groupId, status: 'WAITING' },
    orderBy: { registeredAt: 'asc' }
  });

  if (!nextEntry) {
    return null;
  }

  await tx.groupMember.updateMany({
    where: { groupId, userId: nextEntry.userId, isActive: false },
    data: {
      isActive: true,
      leaveReason: null,
      leftAt: null,
      role: 'member'
    }
  });

  const existingActive = await tx.groupMember.findFirst({
    where: { groupId, userId: nextEntry.userId, isActive: true }
  });

  if (!existingActive) {
    await tx.groupMember.create({
      data: {
        groupId,
        userId: nextEntry.userId,
        role: 'member'
      }
    });
  }

  await tx.groupWaitlistEntry.update({
    where: { id: nextEntry.id },
    data: { status: 'PROMOTED', promotedAt: new Date() }
  });

  const group = await tx.supportGroup.findUnique({ where: { id: groupId } });

  await tx.notification.create({
    data: {
      userId: nextEntry.userId,
      type: 'GROUP_WAITLIST_PROMOTED',
      title: '候补名额已生效',
      content: `您候补的小组「${group?.name ?? ''}」已有成员退出，您已自动成为正式成员。`,
      relatedId: groupId
    }
  });

  return nextEntry;
};

router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const groups = await prisma.supportGroup.findMany({
      where: { status: 'ACTIVE' },
      include: {
        members: {
          where: { isActive: true },
          select: {
            user: {
              select: memberUserSelect
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    });

    const total = await prisma.supportGroup.count({ where: { status: 'ACTIVE' } });

    res.json({
      groups,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    sendInternalError(res, error, '获取小组列表错误', '获取小组列表失败');
  }
});

router.get('/my', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;

    const memberships = await prisma.groupMember.findMany({
      where: { userId, isActive: true },
      include: {
        group: {
          include: {
            members: {
              where: { isActive: true },
              select: {
                user: {
                  select: memberUserSelect
                }
              }
            }
          }
        }
      },
      orderBy: { joinedAt: 'desc' }
    });

    const groups = memberships.map(m => m.group);

    res.json(groups);
  } catch (error) {
    sendInternalError(res, error, '获取我的小组错误', '获取我的小组失败');
  }
});

router.get('/:id', optionalAuthMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const group = await prisma.supportGroup.findUnique({
      where: { id },
      include: {
        members: {
          where: { isActive: true },
          include: {
            user: {
              select: memberUserSelect
            }
          }
        },
        messages: {
          include: {
            user: {
              select: memberUserSelect
            }
          },
          orderBy: { createdAt: 'desc' },
          take: 50
        },
        checkInTemplates: true
      }
    });

    if (!group) {
      return res.status(404).json({ error: '小组不存在' });
    }

    const waitingEntries = await prisma.groupWaitlistEntry.findMany({
      where: { groupId: id, status: 'WAITING' },
      orderBy: { registeredAt: 'asc' },
      select: {
        id: true,
        userId: true,
        registeredAt: true,
        user: { select: memberUserSelect }
      }
    });

    const myMembership = userId
      ? await prisma.groupMember.findFirst({
          where: { groupId: id, userId, isActive: true },
          select: { id: true, role: true }
        })
      : null;

    const isLeader = myMembership?.role === 'leader';
    const myWaitlistPosition = userId
      ? waitingEntries.findIndex(entry => entry.userId === userId) + 1
      : 0;

    let formerMembers: typeof group.members = [];
    if (isLeader) {
      formerMembers = await prisma.groupMember.findMany({
        where: { groupId: id, isActive: false },
        include: {
          user: {
            select: memberUserSelect
          }
        },
        orderBy: { leftAt: 'desc' }
      }) as typeof group.members;
    }

    res.json({
      ...group,
      waitlist: {
        count: waitingEntries.length,
        // 仅组长可查看完整候补名单，其他人只看到人数和自己的位置
        entries: isLeader ? waitingEntries : [],
        myPosition: myWaitlistPosition > 0 ? myWaitlistPosition : null,
        myEntryId: myWaitlistPosition > 0 ? waitingEntries[myWaitlistPosition - 1].id : null
      },
      formerMembers,
      myRole: myMembership?.role ?? null
    });
  } catch (error) {
    sendInternalError(res, error, '获取小组详情错误', '获取小组详情失败');
  }
});

router.post('/', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const validated = createGroupSchema.parse(req.body);
    const userId = req.user!.id;

    const group = await prisma.$transaction(async (tx) => {
      const newGroup = await tx.supportGroup.create({
        data: {
          name: validated.name,
          description: validated.description,
          topic: validated.topic,
          maxMembers: validated.maxMembers,
          meetingTime: validated.meetingTime,
          meetingFrequency: validated.meetingFrequency,
          createdBy: userId,
          status: 'ACTIVE'
        }
      });

      await tx.groupMember.create({
        data: {
          groupId: newGroup.id,
          userId,
          role: 'leader'
        }
      });

      return newGroup;
    });

    res.json({
      message: '小组创建成功',
      group
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '创建小组错误', '创建小组失败');
  }
});

// 加入小组：有名额直接加入；满员且小组开放时转入候补队列
router.post('/:id/join', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const group = await prisma.supportGroup.findUnique({
      where: { id }
    });

    if (!group) {
      return res.status(404).json({ error: '小组不存在' });
    }

    if (group.status === 'CLOSED') {
      return res.status(400).json({ error: '小组已关闭，无法加入或登记候补' });
    }

    const existingMembership = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
      }
    });

    if (existingMembership?.isActive) {
      return res.status(400).json({ error: '您已经是小组成员' });
    }

    if (existingMembership && !existingMembership.isActive) {
      return res.status(400).json({ error: '您曾退出该小组，无法重新加入' });
    }

    const memberCount = await prisma.groupMember.count({
      where: { groupId: id, isActive: true }
    });

    if (memberCount < group.maxMembers) {
      await prisma.groupMember.create({
        data: {
          groupId: id,
          userId,
          role: 'member'
        }
      });

      if (memberCount + 1 >= group.maxMembers && group.status === 'ACTIVE') {
        await prisma.supportGroup.update({
          where: { id },
          data: { status: 'FULL' }
        });
      }

      return res.json({ message: '加入小组成功', waitlisted: false });
    }

    // 小组已满：登记候补
    const existingEntry = await prisma.groupWaitlistEntry.findFirst({
      where: { groupId: id, userId, status: 'WAITING' }
    });

    if (existingEntry) {
      return res.status(400).json({ error: '您已在候补队列中' });
    }

    const entry = await prisma.groupWaitlistEntry.create({
      data: {
        groupId: id,
        userId,
        status: 'WAITING'
      }
    });

    const position = await prisma.groupWaitlistEntry.count({
      where: {
        groupId: id,
        status: 'WAITING',
        registeredAt: { lte: entry.registeredAt }
      }
    });

    res.status(201).json({
      message: '小组已满，已为您登记候补',
      waitlisted: true,
      waitlistEntryId: entry.id,
      position
    });
  } catch (error) {
    sendInternalError(res, error, '加入小组错误', '加入小组失败');
  }
});

// 成员退出（必须填写原因），开放中的小组自动递补最早候补者
router.post('/:id/leave', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const validated = leaveGroupSchema.parse(req.body);

    const group = await prisma.supportGroup.findUnique({
      where: { id }
    });

    if (!group) {
      return res.status(404).json({ error: '小组不存在' });
    }

    const membership = await prisma.groupMember.findFirst({
      where: { groupId: id, userId, isActive: true }
    });

    if (!membership) {
      return res.status(400).json({ error: '您不是该小组的成员' });
    }

    if (membership.role === 'leader') {
      return res.status(400).json({ error: '组长不能退出小组，请先关闭小组' });
    }

    let promoted = false;

    await prisma.$transaction(async (tx) => {
      await tx.groupMember.update({
        where: { id: membership.id },
        data: {
          isActive: false,
          leaveReason: validated.reason,
          leftAt: new Date()
        }
      });

      // 小组关闭后停止递补，只保留退出记录
      if (group.status !== 'CLOSED') {
        const promotedEntry = await promoteNextWaitlisted(tx, id);
        promoted = !!promotedEntry;

        const memberCount = await tx.groupMember.count({
          where: { groupId: id, isActive: true }
        });

        if (memberCount < group.maxMembers && group.status === 'FULL') {
          await tx.supportGroup.update({
            where: { id },
            data: { status: 'ACTIVE' }
          });
        }
      }
    });

    res.json({
      message: '已退出小组',
      promoted
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '退出小组错误', '退出小组失败');
  }
});

// 组长查看候补名单（按登记时间排序）
router.get('/:id/waitlist', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const group = await prisma.supportGroup.findUnique({ where: { id } });
    if (!group) {
      return res.status(404).json({ error: '小组不存在' });
    }

    const membership = await prisma.groupMember.findFirst({
      where: { groupId: id, userId, isActive: true }
    });

    if (!membership || membership.role !== 'leader') {
      return res.status(403).json({ error: '只有组长可以查看候补名单' });
    }

    const entries = await prisma.groupWaitlistEntry.findMany({
      where: { groupId: id },
      orderBy: [{ status: 'asc' }, { registeredAt: 'asc' }],
      include: {
        user: {
          select: memberUserSelect
        }
      }
    });

    res.json(entries);
  } catch (error) {
    sendInternalError(res, error, '获取候补名单错误', '获取候补名单失败');
  }
});

// 组长移除失联的候补者
router.delete('/:id/waitlist/:entryId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id, entryId } = req.params;
    const userId = req.user!.id;
    const validated = removeWaitlistSchema.parse(req.body);

    const group = await prisma.supportGroup.findUnique({ where: { id } });
    if (!group) {
      return res.status(404).json({ error: '小组不存在' });
    }

    const membership = await prisma.groupMember.findFirst({
      where: { groupId: id, userId, isActive: true }
    });

    if (!membership || membership.role !== 'leader') {
      return res.status(403).json({ error: '只有组长可以移除候补者' });
    }

    const entry = await prisma.groupWaitlistEntry.findUnique({
      where: { id: entryId }
    });

    if (!entry || entry.groupId !== id) {
      return res.status(404).json({ error: '候补记录不存在' });
    }

    if (entry.status !== 'WAITING') {
      return res.status(400).json({ error: '该候补记录已不在等候中' });
    }

    await prisma.groupWaitlistEntry.update({
      where: { id: entryId },
      data: {
        status: 'REMOVED',
        removedAt: new Date(),
        removedReason: validated.reason || '组长移除：无法取得联系',
        removedBy: userId
      }
    });

    await prisma.notification.create({
      data: {
        userId: entry.userId,
        type: 'GROUP_WAITLIST_REMOVED',
        title: '候补登记已被移除',
        content: `组长已将您从小组「${group.name}」的候补队列中移除，原因：${validated.reason || '无法取得联系'}。您可以重新登记。`,
        relatedId: id
      }
    });

    res.json({ message: '已移除该候补者' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '移除候补者错误', '移除候补者失败');
  }
});

// 用户取消自己的候补登记
router.post('/:id/waitlist/:entryId/cancel', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id, entryId } = req.params;
    const userId = req.user!.id;

    const entry = await prisma.groupWaitlistEntry.findUnique({
      where: { id: entryId },
      include: { group: true }
    });

    if (!entry || entry.groupId !== id) {
      return res.status(404).json({ error: '候补记录不存在' });
    }

    if (entry.userId !== userId) {
      return res.status(403).json({ error: '只能取消自己的候补登记' });
    }

    if (entry.status !== 'WAITING') {
      return res.status(400).json({ error: '该候补记录已不在等候中' });
    }

    // 小组关闭后名单冻结，不允许改动
    if (entry.group.status === 'CLOSED') {
      return res.status(400).json({ error: '小组已关闭，候补名单已冻结' });
    }

    await prisma.groupWaitlistEntry.update({
      where: { id: entryId },
      data: { status: 'CANCELLED', removedAt: new Date() }
    });

    res.json({ message: '已取消候补登记' });
  } catch (error) {
    sendInternalError(res, error, '取消候补错误', '取消候补登记失败');
  }
});

// 组长关闭小组：保留名单，停止登记和递补
router.post('/:id/close', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const group = await prisma.supportGroup.findUnique({ where: { id } });
    if (!group) {
      return res.status(404).json({ error: '小组不存在' });
    }

    if (group.createdBy !== userId) {
      const membership = await prisma.groupMember.findFirst({
        where: { groupId: id, userId, isActive: true }
      });
      if (!membership || membership.role !== 'leader') {
        return res.status(403).json({ error: '只有组长可以关闭小组' });
      }
    }

    if (group.status === 'CLOSED') {
      return res.status(400).json({ error: '小组已关闭' });
    }

    await prisma.supportGroup.update({
      where: { id },
      data: { status: 'CLOSED' }
    });

    res.json({ message: '小组已关闭，候补登记和递补已停止' });
  } catch (error) {
    sendInternalError(res, error, '关闭小组错误', '关闭小组失败');
  }
});

router.get('/:id/messages', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const isMember = await prisma.groupMember.findFirst({
      where: {
        groupId: id,
        userId,
        isActive: true
      }
    });

    if (!isMember) {
      return res.status(403).json({ error: '您不是小组成员' });
    }

    const messages = await prisma.groupMessage.findMany({
      where: { groupId: id },
      include: {
        user: {
          select: memberUserSelect
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    res.json(messages);
  } catch (error) {
    sendInternalError(res, error, '获取小组消息错误', '获取消息失败');
  }
});

router.post('/:id/messages', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const validated = createMessageSchema.parse(req.body);
    const userId = req.user!.id;

    const isMember = await prisma.groupMember.findFirst({
      where: {
        groupId: id,
        userId,
        isActive: true
      }
    });

    if (!isMember) {
      return res.status(403).json({ error: '您不是小组成员' });
    }

    const message = await prisma.groupMessage.create({
      data: {
        groupId: id,
        userId,
        content: validated.content
      },
      include: {
        user: {
          select: memberUserSelect
        }
      }
    });

    res.json({
      message: '消息发送成功',
      data: message
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '发送消息错误', '发送消息失败');
  }
});

router.post('/:id/checkin-templates', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const validated = createCheckInSchema.parse(req.body);
    const userId = req.user!.id;

    const isLeader = await prisma.groupMember.findFirst({
      where: {
        groupId: id,
        userId,
        isActive: true
      }
    });

    if (!isLeader || isLeader.role !== 'leader') {
      return res.status(403).json({ error: '只有组长可以创建打卡' });
    }

    const template = await prisma.checkInTemplate.create({
      data: {
        groupId: id,
        title: validated.title,
        description: validated.description,
        reminderTime: validated.reminderTime
      }
    });

    res.json({
      message: '打卡模板创建成功',
      template
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '创建打卡模板错误', '创建打卡模板失败');
  }
});

router.post('/checkin/:templateId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { templateId } = req.params;
    const validated = submitCheckInSchema.parse(req.body);
    const userId = req.user!.id;

    const template = await prisma.checkInTemplate.findUnique({
      where: { id: templateId },
      include: { group: true }
    });

    if (!template) {
      return res.status(404).json({ error: '打卡模板不存在' });
    }

    const member = await prisma.groupMember.findFirst({
      where: {
        groupId: template.groupId,
        userId,
        isActive: true
      }
    });

    if (!member) {
      return res.status(403).json({ error: '您不是小组成员' });
    }

    const existingCheckIn = await prisma.checkIn.create({
      data: {
        templateId,
        memberId: member.id,
        userId,
        status: validated.status,
        response: validated.response,
        moodRating: validated.moodRating
      }
    });

    res.json({
      message: '打卡成功',
      checkIn: existingCheckIn
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '打卡错误', '打卡失败');
  }
});

export default router;
