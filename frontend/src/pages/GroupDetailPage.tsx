import React, { useEffect, useState, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { groupAPI } from '../services/api';
import { SupportGroup, GroupMessage, WaitlistEntry, GroupMembershipHistory } from '../types';
import { useAuth } from '../context/AuthContext';

const statusLabel: Record<string, { text: string; className: string }> = {
  WAITING: { text: '等候中', className: 'bg-yellow-100 text-yellow-700' },
  PROMOTED: { text: '已递补', className: 'bg-green-100 text-green-700' },
  REMOVED: { text: '已移除', className: 'bg-red-100 text-red-700' },
  CANCELLED: { text: '已取消', className: 'bg-gray-100 text-gray-600' }
};

const GroupDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [group, setGroup] = useState<SupportGroup | null>(null);
  const [loading, setLoading] = useState(true);
  const [newMessage, setNewMessage] = useState('');
  const [isMember, setIsMember] = useState(false);
  const [isLeader, setIsLeader] = useState(false);
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const [leaveReason, setLeaveReason] = useState('');
  const [showWaitlistModal, setShowWaitlistModal] = useState(false);
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [history, setHistory] = useState<GroupMembershipHistory[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { user } = useAuth();

  const myWaitlist = group?.myWaitlist ?? null;
  const isWaiting = myWaitlist?.status === 'WAITING';

  const refreshGroup = async () => {
    const response = await groupAPI.getGroup(id!);
    setGroup(response.data);
    if (user) {
      const member = response.data.members?.find((m: any) => m.userId === user.id);
      setIsMember(!!member);
      setIsLeader(member?.role === 'leader');
    } else {
      setIsMember(false);
      setIsLeader(false);
    }
  };

  useEffect(() => {
    const fetchGroup = async () => {
      try {
        await refreshGroup();
      } catch (error) {
        console.error('获取小组详情失败:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchGroup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [group?.messages]);

  const handleJoinGroup = async () => {
    try {
      const res = await groupAPI.joinGroup(id!);
      if (res.data.waitlisted) {
        alert(`小组已满，已为您登记候补，前面还有 ${res.data.aheadCount} 人。`);
      } else {
        alert('加入小组成功！');
      }
      await refreshGroup();
    } catch (error: any) {
      alert(error.response?.data?.error || '操作失败');
    }
  };

  const handleCancelWaitlist = async () => {
    if (!window.confirm('确定取消候补登记吗？')) return;
    try {
      await groupAPI.cancelWaitlist(id!);
      await refreshGroup();
    } catch (error: any) {
      alert(error.response?.data?.error || '取消候补失败');
    }
  };

  const handleLeaveGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!leaveReason.trim()) {
      alert('请填写退出原因');
      return;
    }
    try {
      const res = await groupAPI.leaveGroup(id!, { reason: leaveReason.trim() });
      setShowLeaveModal(false);
      setLeaveReason('');
      alert(
        res.data.promotedUserId
          ? '已退出小组，已自动递补最早等候者。'
          : '已退出小组。'
      );
      await refreshGroup();
    } catch (error: any) {
      alert(error.response?.data?.error || '退出失败');
    }
  };

  const handleCloseGroup = async () => {
    if (!window.confirm('关闭后将停止登记与候补递补，成员和候补名单会保留。确定关闭吗？')) return;
    try {
      await groupAPI.closeGroup(id!);
      alert('小组已关闭');
      await refreshGroup();
    } catch (error: any) {
      alert(error.response?.data?.error || '关闭失败');
    }
  };

  const openWaitlistModal = async () => {
    setShowWaitlistModal(true);
    try {
      const res = await groupAPI.getWaitlist(id!);
      setWaitlist(res.data);
    } catch (error: any) {
      alert(error.response?.data?.error || '获取候补名单失败');
    }
  };

  const handleRemoveWaitlistEntry = async (entry: WaitlistEntry) => {
    const reason = window.prompt(
      `确定将「${entry.user.nickname || entry.user.username}」移出候补队列吗？可填写移除原因：`,
      '失联'
    );
    if (reason === null) return;
    try {
      await groupAPI.removeWaitlistEntry(id!, entry.id, { reason: reason.trim() || undefined });
      const res = await groupAPI.getWaitlist(id!);
      setWaitlist(res.data);
      await refreshGroup();
    } catch (error: any) {
      alert(error.response?.data?.error || '移除失败');
    }
  };

  const openHistoryModal = async () => {
    setShowHistoryModal(true);
    try {
      const res = await groupAPI.getMembershipHistory(id!);
      setHistory(res.data);
    } catch (error: any) {
      alert(error.response?.data?.error || '获取成员变动记录失败');
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim()) return;

    try {
      await groupAPI.sendMessage(id!, { content: newMessage });
      setNewMessage('');
      await refreshGroup();
    } catch (error: any) {
      alert(error.response?.data?.error || '发送失败');
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8 text-center">
        <div className="text-gray-500">加载中...</div>
      </div>
    );
  }

  if (!group) {
    return (
      <div className="container mx-auto px-4 py-8 text-center">
        <div className="text-gray-500">小组不存在</div>
        <Link to="/groups" className="text-primary-600 hover:underline mt-4 inline-block">
          返回小组列表
        </Link>
      </div>
    );
  }

  const renderJoinArea = () => {
    if (!user) return null;
    if (isMember) {
      return (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <span className="text-sm text-green-700 bg-green-100 px-3 py-1 rounded-full">
            {isLeader ? '您是组长' : '您已加入该小组'}
          </span>
          {!isLeader && (
            <button onClick={() => setShowLeaveModal(true)} className="btn-secondary text-red-600">
              退出小组
            </button>
          )}
          {isLeader && (
            <>
              <button onClick={openWaitlistModal} className="btn-secondary">
                候补名单 ({group.waitingCount || 0})
              </button>
              <button onClick={openHistoryModal} className="btn-secondary">
                退出记录
              </button>
              {group.status !== 'CLOSED' && (
                <button onClick={handleCloseGroup} className="btn-secondary text-red-600">
                  关闭小组
                </button>
              )}
            </>
          )}
        </div>
      );
    }

    if (group.status === 'CLOSED') {
      return (
        <p className="mt-6 text-sm text-gray-500">
          小组已关闭，登记与候补均已停止。
        </p>
      );
    }

    if (isWaiting) {
      return (
        <div className="mt-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="text-sm text-yellow-800">
            🕓 您已在候补队列中，登记时间：{new Date(myWaitlist!.registeredAt).toLocaleString()}
          </p>
          <p className="text-sm font-semibold text-yellow-900 mt-1">
            前面还有 {myWaitlist!.aheadCount} 人，有成员退出时将按登记顺序自动递补并通知您。
          </p>
          <button onClick={handleCancelWaitlist} className="btn-secondary mt-3 text-sm">
            取消候补
          </button>
        </div>
      );
    }

    if (group.status === 'FULL') {
      return (
        <div className="mt-6">
          <p className="text-sm text-gray-600 mb-2">
            小组已满，当前有 {group.waitingCount || 0} 人候补。登记后有名额腾出将按顺序自动递补。
          </p>
          <button onClick={handleJoinGroup} className="btn-primary">
            登记候补
          </button>
        </div>
      );
    }

    return (
      <button onClick={handleJoinGroup} className="btn-primary mt-6">
        加入小组
      </button>
    );
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <Link to="/groups" className="text-primary-600 hover:underline mb-6 inline-block">
        ← 返回小组列表
      </Link>

      <div className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
          <div className="bg-white rounded-lg shadow-md p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h1 className="text-2xl font-bold text-gray-800">{group.name}</h1>
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                group.status === 'ACTIVE' ? 'bg-green-100 text-green-700' :
                group.status === 'FULL' ? 'bg-yellow-100 text-yellow-700' :
                'bg-gray-100 text-gray-700'
              }`}>
                {group.status === 'ACTIVE' ? '招募中' :
                 group.status === 'FULL' ? '已满员' : '已关闭'}
              </span>
            </div>

            <p className="text-gray-600 mb-4">{group.description}</p>

            <div className="flex flex-wrap gap-3 text-sm">
              <span className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full">
                主题：{group.topic}
              </span>
              {group.meetingTime && (
                <span className="px-3 py-1 bg-purple-100 text-purple-700 rounded-full">
                  {group.meetingTime}
                </span>
              )}
              {group.meetingFrequency && (
                <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full">
                  {group.meetingFrequency}
                </span>
              )}
              {(group.waitingCount || 0) > 0 && (
                <span className="px-3 py-1 bg-yellow-100 text-yellow-700 rounded-full">
                  候补 {group.waitingCount} 人
                </span>
              )}
            </div>

            {renderJoinArea()}
          </div>

          <div className="bg-white rounded-lg shadow-md">
            <div className="p-6 border-b">
              <h2 className="text-xl font-bold text-gray-800">小组交流</h2>
            </div>

            <div className="h-96 overflow-y-auto p-6 space-y-4">
              {group.messages?.length === 0 ? (
                <div className="text-center text-gray-500 py-8">
                  还没有消息，快来发表第一条消息吧！
                </div>
              ) : (
                group.messages?.map((message: GroupMessage) => (
                  <div
                    key={message.id}
                    className={`flex gap-3 ${
                      user && message.userId === user.id ? 'flex-row-reverse' : ''
                    }`}
                  >
                    <div className="w-10 h-10 bg-gray-200 rounded-full flex-shrink-0 flex items-center justify-center">
                      👤
                    </div>
                    <div className={`max-w-[70%] ${
                      user && message.userId === user.id ? 'text-right' : ''
                    }`}>
                      <p className="text-sm text-gray-500 mb-1">
                        {message.user.nickname || message.user.username}
                        <span className="ml-2 text-xs">
                          {new Date(message.createdAt).toLocaleString()}
                        </span>
                      </p>
                      <div className={`inline-block p-3 rounded-lg ${
                        user && message.userId === user.id
                          ? 'bg-primary-500 text-white rounded-br-none'
                          : 'bg-gray-100 text-gray-800 rounded-bl-none'
                      }`}>
                        {message.content}
                      </div>
                    </div>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {isMember && (
              <div className="p-4 border-t">
                <form onSubmit={handleSendMessage} className="flex gap-3">
                  <input
                    type="text"
                    value={newMessage}
                    onChange={e => setNewMessage(e.target.value)}
                    className="flex-1 input-field"
                    placeholder="输入消息..."
                  />
                  <button type="submit" className="btn-primary">
                    发送
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-1">
          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">
              小组成员 ({group.members?.length || 0}/{group.maxMembers})
            </h3>
            <div className="space-y-3">
              {group.members?.map((member: any) => (
                <div key={member.id} className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-gray-200 rounded-full flex items-center justify-center">
                    👤
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-gray-800">
                      {member.user.nickname || member.user.username}
                    </p>
                    {member.role === 'leader' && (
                      <span className="text-xs text-primary-600">组长</span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {(group.waitingCount || 0) > 0 && (
              <div className="mt-4 pt-4 border-t text-sm text-gray-600">
                🕓 {group.waitingCount} 人正在候补
                {isWaiting && `，您前面还有 ${myWaitlist!.aheadCount} 人`}
              </div>
            )}

            {isLeader && (
              <div className="mt-4 pt-4 border-t space-y-2">
                <button onClick={openWaitlistModal} className="btn-secondary w-full text-sm">
                  管理候补名单
                </button>
                <button onClick={openHistoryModal} className="btn-secondary w-full text-sm">
                  成员退出记录
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {showLeaveModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-bold mb-2">退出小组</h2>
            <p className="text-sm text-gray-600 mb-4">
              {group.status === 'CLOSED'
                ? '小组已关闭，退出后名额不再递补。请填写退出原因：'
                : '退出后名额将按候补登记顺序自动递补。请填写退出原因：'}
            </p>
            <form onSubmit={handleLeaveGroup}>
              <textarea
                value={leaveReason}
                onChange={e => setLeaveReason(e.target.value)}
                className="input-field min-h-[100px]"
                placeholder="例如：时间安排冲突、个人原因等"
                required
                minLength={2}
                maxLength={500}
              />
              <div className="flex justify-end gap-3 mt-4">
                <button
                  type="button"
                  onClick={() => { setShowLeaveModal(false); setLeaveReason(''); }}
                  className="btn-secondary"
                >
                  取消
                </button>
                <button type="submit" className="btn-primary bg-red-600 hover:bg-red-700">
                  确认退出
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showWaitlistModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold">
                候补名单
                {group.status === 'CLOSED' && (
                  <span className="ml-2 text-sm font-normal text-gray-500">（小组已关闭，名单保留）</span>
                )}
              </h2>
              <button onClick={() => setShowWaitlistModal(false)} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">
                ×
              </button>
            </div>
            {waitlist.length === 0 ? (
              <p className="text-center text-gray-500 py-8">暂无候补记录</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <th className="py-2 pr-2">登记时间</th>
                    <th className="py-2 pr-2">用户</th>
                    <th className="py-2 pr-2">状态</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {waitlist.map(entry => (
                    <tr key={entry.id} className="border-b last:border-0">
                      <td className="py-2 pr-2 whitespace-nowrap">
                        {new Date(entry.registeredAt).toLocaleString()}
                      </td>
                      <td className="py-2 pr-2">
                        {entry.user.nickname || entry.user.username}
                        {entry.removeReason && (
                          <span className="block text-xs text-gray-400">原因：{entry.removeReason}</span>
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        <span className={`px-2 py-0.5 rounded-full text-xs ${statusLabel[entry.status]?.className || ''}`}>
                          {statusLabel[entry.status]?.text || entry.status}
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        {entry.status === 'WAITING' && group.status !== 'CLOSED' && (
                          <button
                            onClick={() => handleRemoveWaitlistEntry(entry)}
                            className="text-red-600 hover:underline text-xs"
                          >
                            移除（失联）
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {showHistoryModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold">成员退出记录</h2>
              <button onClick={() => setShowHistoryModal(false)} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">
                ×
              </button>
            </div>
            {history.length === 0 ? (
              <p className="text-center text-gray-500 py-8">暂无退出记录</p>
            ) : (
              <div className="space-y-3">
                {history.map(item => (
                  <div key={item.id} className="border rounded-lg p-3 text-sm">
                    <div className="flex justify-between items-start mb-1">
                      <span className="font-medium">
                        {item.user.nickname || item.user.username}
                      </span>
                      <span className="text-xs text-gray-400">
                        {new Date(item.leftAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-gray-600">退出原因：{item.leaveReason}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default GroupDetailPage;
