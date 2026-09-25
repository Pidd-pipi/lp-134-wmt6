-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('WAITING', 'PROMOTED', 'CANCELLED', 'REMOVED');

-- AlterTable: 小组成员支持软删除并保留退出原因
ALTER TABLE "group_members" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "group_members" ADD COLUMN "leaveReason" TEXT;
ALTER TABLE "group_members" ADD COLUMN "leftAt" TIMESTAMP(3);

-- CreateTable: 小组候补队列
CREATE TABLE "group_waitlist_entries" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "removedReason" TEXT,
    "removedBy" TEXT,

    CONSTRAINT "group_waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: 按小组、状态、登记时间排序候补名单
CREATE INDEX "group_waitlist_entries_groupId_status_registeredAt_idx"
    ON "group_waitlist_entries"("groupId", "status", "registeredAt");

-- AddForeignKey
ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "support_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
