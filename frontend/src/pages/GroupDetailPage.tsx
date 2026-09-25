import React, { useEffect, useState, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { groupAPI } from '../services/api';
import { SupportGroup, GroupMessage } from '../types';
import { useAuth } from '../context/AuthContext';

const GroupDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [group, setGroup] = useState<SupportGroup | null>(null);
  const [loading, setLoading] = useState(true);
  const [newMessage, setNewMessage] = useState('');
  const [isMember, setIsMember] = useState(false);
  const [isLeader, setIsLeader] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { user } = useAuth();

  useEffect(() => {
    const fetchGroup = async () => {
      try {
        const response = await groupAPI.getGroup(id!);
        setGroup(response.data);
        if (user) {
          setIsMember(response.data.members?.some((m: any) => m.userId === user.id) || false);
          setIsLeader(
            response.data.members?.some((m: any) => m.userId === user.id && m.role === 'leader') || false
          );
        }
      } catch (error) {
        console.error('获取小组详情失败:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchGroup();
  }, [id, user]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [group?.messages]);

  const refreshGroup = async () => {
    const response = await groupAPI.getGroup(id!);
    setGroup(response.data);
    if (user) {
      setIsMember(response.data.members?.some((m: any) => m.userId === user.id) || false);
      setIsLeader(
        response.data.members?.some((m: any) => m.userId === user.id && m.role === 'leader') || false
      );
    }
  };

  const handleJoinGroup = async () => {
    try {
      const res = await groupAPI.joinGroup(id!);
      await refreshGroup();
      if (res.data.waitlisted) {
        alert(`小组已满，已为您登记候补，当前前面有 ${res.data.position - 1} 人等待。`);
      } else {
        alert('加入小组成功！');
      }
    } catch (error: any) {
      alert(error.response?.data?.error || '操作失败');
    }
  };

  const handleLeaveGroup = async () => {
    const reason = prompt('确定要退出小组吗？请填写退出原因（将记录在案）：');
    if (reason === null) return;
    if (!reason.trim()) {
      alert('退出原因不能为空');
      return;
    }
    try {
      const res = await groupAPI.leaveGroup(id!, { reason: reason.trim() });
      await refreshGroup();
      alert(res.data.promoted ? '已退出小组，最早的候补者已自动递补。' : '已退出小组。');
    } catch (error: any) {
      alert(error.response?.data?.error || '退出失败');
    }
  };

  const handleCloseGroup = async () => {
    if (!confirm('关闭小组后将停止登记和递补，成员和候补名单会保留。确定关闭吗？')) return;
    try {
      await groupAPI.closeGroup(id!);
      await refreshGroup();
      alert('小组已关闭');
    } catch (error: any) {
      alert(error.response?.data?.error || '关闭失败');
    }
  };

  const handleCancelWaitlist = async () => {
    if (!group?.waitlist?.myEntryId) return;
    if (!confirm('确定取消候补登记吗？')) return;
    try {
      await groupAPI.cancelWaitlistEntry(id!, group.waitlist.myEntryId);
      await refreshGroup();
    } catch (error: any) {
      alert(error.response?.data?.error || '取消失败');
    }
  };

  const handleRemoveWaitlisted = async (entryId: string, username: string) => {
    const reason = prompt(`移除候补者「${username}」的原因（可选，用于通知对方）：`, '无法取得联系');
    if (reason === null) return;
    try {
      await groupAPI.removeWaitlistEntry(id!, entryId, { reason: reason.trim() || undefined });
      await refreshGroup();
    } catch (error: any) {
      alert(error.response?.data?.error || '移除失败');
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

  const memberCount = group.members?.length || 0;
  const isFull = memberCount >= group.maxMembers;
  const myPosition = group.waitlist?.myPosition ?? null;
  const isWaiting = myPosition !== null;

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
            </div>

            {user && !isMember && !isWaiting && group.status !== 'CLOSED' && (
              <button
                onClick={handleJoinGroup}
                className="btn-primary mt-6"
              >
                {isFull ? '已满员，登记候补' : '加入小组'}
              </button>
            )}

            {user && isWaiting && (
              <div className="mt-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                <p className="text-yellow-800 font-medium">
                  ⏳ 您已在候补队列中
                </p>
                <p className="text-sm text-yellow-700 mt-1">
                  前面还有 <span className="font-bold text-lg">{myPosition! - 1}</span> 人等待
                  {myPosition === 1 && '（您是下一个，成员退出后将自动递补）'}
                </p>
                <button
                  onClick={handleCancelWaitlist}
                  className="mt-3 text-sm text-red-600 hover:underline"
                >
                  取消候补登记
                </button>
              </div>
            )}

            {group.status === 'CLOSED' && (
              <p className="mt-6 text-sm text-gray-500">
                小组已关闭，候补登记和自动递补均已停止，成员与候补名单仍予以保留。
              </p>
            )}

            {isMember && (
              <div className="mt-6 flex gap-3">
                {!isLeader && (
                  <button
                    onClick={handleLeaveGroup}
                    className="text-sm text-red-600 hover:underline"
                  >
                    退出小组（需填写原因）
                  </button>
                )}
                {isLeader && group.status !== 'CLOSED' && (
                  <button
                    onClick={handleCloseGroup}
                    className="text-sm text-gray-600 hover:underline"
                  >
                    关闭小组
                  </button>
                )}
              </div>
            )}
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

        <div className="lg:col-span-1 space-y-6">
          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">
              小组成员 ({memberCount}/{group.maxMembers})
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
          </div>

          {/* 候补队列：组长可见完整名单并可移除失联者 */}
          {isLeader ? (
            <div className="bg-white rounded-lg shadow-md p-6">
              <h3 className="text-lg font-semibold text-gray-800 mb-1">
                候补队列 ({group.waitlist?.count || 0})
              </h3>
              <p className="text-xs text-gray-500 mb-4">按登记时间排序，成员退出后队首自动递补</p>
              {group.waitlist?.entries?.length === 0 ? (
                <p className="text-sm text-gray-500">暂无候补者</p>
              ) : (
                <div className="space-y-3">
                  {group.waitlist?.entries.map((entry, index) => (
                    <div key={entry.id} className="flex items-center gap-3">
                      <span className="w-6 h-6 flex-shrink-0 bg-yellow-100 text-yellow-700 rounded-full flex items-center justify-center text-xs font-medium">
                        {index + 1}
                      </span>
                      <div className="w-9 h-9 bg-gray-200 rounded-full flex items-center justify-center">
                        👤
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-800 text-sm truncate">
                          {entry.user.nickname || entry.user.username}
                        </p>
                        <p className="text-xs text-gray-500">
                          {new Date(entry.registeredAt).toLocaleString()}
                        </p>
                      </div>
                      <button
                        onClick={() => handleRemoveWaitlisted(entry.id, entry.user.nickname || entry.user.username)}
                        className="text-xs text-red-600 hover:underline flex-shrink-0"
                      >
                        移除
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            (group.waitlist?.count ?? 0) > 0 && (
              <div className="bg-white rounded-lg shadow-md p-6">
                <h3 className="text-lg font-semibold text-gray-800 mb-1">候补队列</h3>
                <p className="text-sm text-gray-500">
                  当前有 <span className="font-medium text-yellow-700">{group.waitlist?.count}</span> 人等候
                </p>
              </div>
            )
          )}

          {/* 组长可见：退出成员记录（含退出原因） */}
          {isLeader && group.formerMembers && group.formerMembers.length > 0 && (
            <div className="bg-white rounded-lg shadow-md p-6">
              <h3 className="text-lg font-semibold text-gray-800 mb-4">退出记录</h3>
              <div className="space-y-3">
                {group.formerMembers.map((member: any) => (
                  <div key={member.id} className="border-l-2 border-gray-200 pl-3">
                    <p className="font-medium text-gray-700 text-sm">
                      {member.user.nickname || member.user.username}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {member.leftAt ? new Date(member.leftAt).toLocaleString() : ''} 退出
                    </p>
                    <p className="text-sm text-gray-600 mt-1">原因：{member.leaveReason}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default GroupDetailPage;
