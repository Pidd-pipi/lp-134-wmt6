import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
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
  reason: z.string().min(2, '请填写退出原因').max(500)
});

const removeWaitlistSchema = z.object({
  reason: z.string().max(200).optional()
});

const waitlistUserSelect = {
  id: true,
  status: true,
  registeredAt: true,
  promotedAt: true,
  removedAt: true,
  removeReason: true,
  user: {
    select: {
      id: true,
      username: true,
      nickname: true,
      avatar: true
    }
  }
} as const;

/** 查询某用户在候补队列中前面还有多少位等候者（按登记时间升序） */
const countAhead = async (tx: Prisma.TransactionClient | typeof prisma, groupId: string, registeredAt: Date): Promise<number> => {
  return tx.groupWaitlistEntry.count({
    where: {
      groupId,
      status: 'WAITING',
      registeredAt: { lt: registeredAt }
    }
  });
};

/** 发放一个名额：将最早等候者递补为正式成员，并发送通知。返回被递补者（如有）。 */
const promoteNextWaiter = async (tx: Prisma.TransactionClient, groupId: string, groupName: string) => {
  const next = await tx.groupWaitlistEntry.findFirst({
    where: { groupId, status: 'WAITING' },
    orderBy: { registeredAt: 'asc' }
  });

  if (!next) {
    return null;
  }

  await tx.groupMember.create({
    data: {
      groupId,
      userId: next.userId,
      role: 'member'
    }
  });

  await tx.groupWaitlistEntry.update({
    where: { id: next.id },
    data: { status: 'PROMOTED', promotedAt: new Date() }
  });

  await tx.notification.create({
    data: {
      userId: next.userId,
      type: 'GROUP_WAITLIST_PROMOTED',
      title: '候补名额已生效',
      content: `您候补的小组「${groupName}」已有成员退出，您已自动成为正式成员。`,
      relatedId: groupId
    }
  });

  return next;
};

router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const groups = await prisma.supportGroup.findMany({
      where: { status: { in: ['ACTIVE', 'FULL'] } },
      include: {
        members: {
          select: {
            user: {
              select: {
                id: true,
                username: true,
                nickname: true,
                avatar: true
              }
            }
          }
        },
        _count: {
          select: { waitlistEntries: { where: { status: 'WAITING' } } }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    });

    const total = await prisma.supportGroup.count({ where: { status: { in: ['ACTIVE', 'FULL'] } } });

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
      where: { userId },
      include: {
        group: {
          include: {
            members: {
              select: {
                user: {
                  select: {
                    id: true,
                    username: true,
                    nickname: true,
                    avatar: true
                  }
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

    const group = await prisma.supportGroup.findUnique({
      where: { id },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                nickname: true,
                avatar: true
              }
            }
          }
        },
        messages: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                nickname: true,
                avatar: true
              }
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

    // 完整候补名单仅组长通过专用接口查看，详情接口只返回候补总数；
    // 登录用户额外获得本人候补状态与前面等待人数。
    const waitingCount = await prisma.groupWaitlistEntry.count({
      where: { groupId: id, status: 'WAITING' }
    });

    let myWaitlist: {
      id: string;
      status: 'WAITING' | 'PROMOTED' | 'REMOVED' | 'CANCELLED';
      registeredAt: Date;
      aheadCount: number;
    } | null = null;

    if (req.user) {
      const myEntry = await prisma.groupWaitlistEntry.findUnique({
        where: {
          groupId_userId: {
            groupId: id,
            userId: req.user.id
          }
        }
      });

      if (myEntry) {
        const aheadCount = myEntry.status === 'WAITING'
          ? await countAhead(prisma, id, myEntry.registeredAt)
          : 0;

        myWaitlist = {
          id: myEntry.id,
          status: myEntry.status,
          registeredAt: myEntry.registeredAt,
          aheadCount
        };
      }
    }

    res.json({
      ...group,
      waitingCount,
      myWaitlist
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
      return res.status(400).json({ error: '小组已关闭，不再接受加入或候补登记' });
    }

    const existingMember = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
      }
    });

    if (existingMember) {
      return res.status(400).json({ error: '您已经是小组成员' });
    }

    const existingWaitlist = await prisma.groupWaitlistEntry.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
      }
    });

    if (existingWaitlist?.status === 'WAITING') {
      const aheadCount = await countAhead(prisma, id, existingWaitlist.registeredAt);
      return res.status(400).json({
        error: '您已在候补队列中',
        waitlist: { aheadCount, registeredAt: existingWaitlist.registeredAt }
      });
    }

    const memberCount = await prisma.groupMember.count({
      where: { groupId: id }
    });

    // 满员时进入候补队列（关闭状态已在前面拦截）
    if (memberCount >= group.maxMembers) {
      // 历史上曾被移除/取消的记录复用同一行，更新为重新等候
      const entry = existingWaitlist
        ? await prisma.groupWaitlistEntry.update({
            where: { id: existingWaitlist.id },
            data: {
              status: 'WAITING',
              registeredAt: new Date(),
              promotedAt: null,
              removedAt: null,
              removedBy: null,
              removeReason: null
            }
          })
        : await prisma.groupWaitlistEntry.create({
            data: {
              groupId: id,
              userId,
              status: 'WAITING'
            }
          });

      if (group.status !== 'FULL') {
        await prisma.supportGroup.update({
          where: { id },
          data: { status: 'FULL' }
        });
      }

      const aheadCount = await countAhead(prisma, id, entry.registeredAt);

      return res.status(201).json({
        message: '小组已满，已为您登记候补',
        waitlisted: true,
        aheadCount,
        registeredAt: entry.registeredAt
      });
    }

    await prisma.groupMember.create({
      data: {
        groupId: id,
        userId,
        role: 'member'
      }
    });

    if (memberCount + 1 >= group.maxMembers) {
      await prisma.supportGroup.update({
        where: { id },
        data: { status: 'FULL' }
      });
    }

    res.json({ message: '加入小组成功', waitlisted: false });
  } catch (error) {
    sendInternalError(res, error, '加入小组错误', '加入小组失败');
  }
});

/** 取消本人的候补登记 */
router.post('/:id/waitlist/cancel', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const entry = await prisma.groupWaitlistEntry.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
      }
    });

    if (!entry || entry.status !== 'WAITING') {
      return res.status(400).json({ error: '您没有进行中的候补登记' });
    }

    await prisma.groupWaitlistEntry.update({
      where: { id: entry.id },
      data: { status: 'CANCELLED', removedAt: new Date(), removedBy: userId }
    });

    res.json({ message: '已取消候补登记' });
  } catch (error) {
    sendInternalError(res, error, '取消候补错误', '取消候补失败');
  }
});

/** 组长查看候补名单（按登记时间升序，含全部状态，便于关闭后留存） */
router.get('/:id/waitlist', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const leader = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
      }
    });

    if (!leader || leader.role !== 'leader') {
      return res.status(403).json({ error: '只有组长可以查看候补名单' });
    }

    const entries = await prisma.groupWaitlistEntry.findMany({
      where: { groupId: id },
      select: waitlistUserSelect,
      orderBy: { registeredAt: 'asc' }
    });

    // 等候中的条目排在最前，其次按登记时间升序；其余状态保持登记时间顺序
    const statusWeight: Record<string, number> = {
      WAITING: 0,
      PROMOTED: 1,
      REMOVED: 2,
      CANCELLED: 3
    };
    entries.sort((a, b) => {
      const weightDiff = statusWeight[a.status] - statusWeight[b.status];
      return weightDiff !== 0
        ? weightDiff
        : a.registeredAt.getTime() - b.registeredAt.getTime();
    });

    res.json(entries);
  } catch (error) {
    sendInternalError(res, error, '获取候补名单错误', '获取候补名单失败');
  }
});

/** 组长移除候补队列中的失联者 */
router.delete('/:id/waitlist/:entryId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id, entryId } = req.params;
    const userId = req.user!.id;
    const validated = removeWaitlistSchema.parse(req.body || {});

    const leader = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
      }
    });

    if (!leader || leader.role !== 'leader') {
      return res.status(403).json({ error: '只有组长可以移除候补者' });
    }

    const entry = await prisma.groupWaitlistEntry.findUnique({
      where: { id: entryId },
      include: { group: true }
    });

    if (!entry || entry.groupId !== id) {
      return res.status(404).json({ error: '候补记录不存在' });
    }

    if (entry.status !== 'WAITING') {
      return res.status(400).json({ error: '该候补记录不在等候中' });
    }

    await prisma.groupWaitlistEntry.update({
      where: { id: entry.id },
      data: {
        status: 'REMOVED',
        removedAt: new Date(),
        removedBy: userId,
        removeReason: validated.reason || '组长移除（失联）'
      }
    });

    await prisma.notification.create({
      data: {
        userId: entry.userId,
        type: 'GROUP_WAITLIST_REMOVED',
        title: '候补登记已被移除',
        content: `组长已将您从小组「${entry.group.name}」的候补队列中移除，如有疑问请联系组长。`,
        relatedId: id
      }
    });

    res.json({ message: '已从候补队列移除' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '移除候补者错误', '移除候补者失败');
  }
});

/** 成员退出小组：必须填写原因；小组仍开启时自动递补最早等候者 */
router.post('/:id/leave', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const validated = leaveGroupSchema.parse(req.body);

    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
      },
      include: { group: true }
    });

    if (!member) {
      return res.status(400).json({ error: '您不是该小组成员' });
    }

    if (member.role === 'leader') {
      return res.status(400).json({ error: '组长不能退出，请先关闭小组或转让组长' });
    }

    const promoted = await prisma.$transaction(async (tx) => {
      // 留存退出记录与原因（小组关闭后同样保留）
      await tx.groupMembershipHistory.create({
        data: {
          groupId: id,
          userId,
          role: member.role,
          joinedAt: member.joinedAt,
          leaveReason: validated.reason,
          leftBy: userId
        }
      });

      await tx.groupMember.delete({
        where: { id: member.id }
      });

      let promotedUser: { userId: string } | null = null;

      // 仅在小组仍开启（ACTIVE/FULL）时递补；已关闭则停止递补
      if (member.group.status !== 'CLOSED') {
        const next = await promoteNextWaiter(tx, id, member.group.name);
        promotedUser = next ? { userId: next.userId } : null;

        const memberCount = await tx.groupMember.count({ where: { groupId: id } });
        await tx.supportGroup.update({
          where: { id },
          data: { status: memberCount >= member.group.maxMembers ? 'FULL' : 'ACTIVE' }
        });
      }

      return promotedUser;
    });

    res.json({
      message: '已退出小组',
      promotedUserId: promoted?.userId || null
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendValidationError(res, error);
    }
    sendInternalError(res, error, '退出小组错误', '退出小组失败');
  }
});

/** 组长关闭小组：保留成员与候补名单，但停止登记与递补 */
router.post('/:id/close', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const leader = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
      }
    });

    if (!leader || leader.role !== 'leader') {
      return res.status(403).json({ error: '只有组长可以关闭小组' });
    }

    const group = await prisma.supportGroup.update({
      where: { id },
      data: { status: 'CLOSED' }
    });

    // 通知尚在等候的成员：候补已停止递补，名单予以保留
    const waitingEntries = await prisma.groupWaitlistEntry.findMany({
      where: { groupId: id, status: 'WAITING' },
      select: { userId: true }
    });

    if (waitingEntries.length > 0) {
      await prisma.notification.createMany({
        data: waitingEntries.map(entry => ({
          userId: entry.userId,
          type: 'GROUP_CLOSED',
          title: '小组已关闭',
          content: `小组「${group.name}」已关闭，候补登记停止，您的登记记录将被保留。`,
          relatedId: id
        }))
      });
    }

    res.json({ message: '小组已关闭' });
  } catch (error) {
    sendInternalError(res, error, '关闭小组错误', '关闭小组失败');
  }
});

/** 组长查看成员变动记录（含退出原因，关闭后仍可查看） */
router.get('/:id/history', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const leader = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
      }
    });

    if (!leader || leader.role !== 'leader') {
      return res.status(403).json({ error: '只有组长可以查看成员变动记录' });
    }

    const history = await prisma.groupMembershipHistory.findMany({
      where: { groupId: id },
      orderBy: { leftAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            nickname: true,
            avatar: true
          }
        }
      }
    });

    res.json(history);
  } catch (error) {
    sendInternalError(res, error, '获取成员变动记录错误', '获取成员变动记录失败');
  }
});

router.get('/:id/messages', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const isMember = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
      }
    });

    if (!isMember) {
      return res.status(403).json({ error: '您不是小组成员' });
    }

    const messages = await prisma.groupMessage.findMany({
      where: { groupId: id },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            nickname: true,
            avatar: true
          }
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

    const isMember = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
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
          select: {
            id: true,
            username: true,
            nickname: true,
            avatar: true
          }
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

    const isLeader = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: id,
          userId
        }
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

    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: template.groupId,
          userId
        }
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
