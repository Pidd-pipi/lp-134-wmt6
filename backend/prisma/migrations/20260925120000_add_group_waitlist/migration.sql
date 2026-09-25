-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('WAITING', 'PROMOTED', 'REMOVED', 'CANCELLED');

-- DropForeignKey
ALTER TABLE "group_members" DROP CONSTRAINT "group_members_groupId_fkey";

-- DropForeignKey
ALTER TABLE "group_members" DROP CONSTRAINT "group_members_userId_fkey";

-- DropForeignKey
ALTER TABLE "checkins" DROP CONSTRAINT "checkins_templateId_fkey";

-- DropForeignKey
ALTER TABLE "checkins" DROP CONSTRAINT "checkins_memberId_fkey";

-- DropForeignKey
ALTER TABLE "checkins" DROP CONSTRAINT "checkins_userId_fkey";

-- CreateTable
CREATE TABLE "group_waitlist_entries" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "removedBy" TEXT,
    "removeReason" TEXT,

    CONSTRAINT "group_waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_membership_history" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joinedAt" TIMESTAMP(3) NOT NULL,
    "leftAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaveReason" TEXT NOT NULL,
    "leftBy" TEXT NOT NULL,

    CONSTRAINT "group_membership_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_waitlist_entries_groupId_status_registeredAt_idx" ON "group_waitlist_entries"("groupId", "status", "registeredAt");

-- CreateIndex
CREATE UNIQUE INDEX "group_waitlist_entries_groupId_userId_key" ON "group_waitlist_entries"("groupId", "userId");

-- CreateIndex
CREATE INDEX "group_membership_history_groupId_leftAt_idx" ON "group_membership_history"("groupId", "leftAt");

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "support_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "support_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_membership_history" ADD CONSTRAINT "group_membership_history_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "support_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_membership_history" ADD CONSTRAINT "group_membership_history_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "checkin_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "group_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
