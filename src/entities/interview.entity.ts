import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AdminUser } from './admin-user.entity.js';
import { encrypted } from '../lib/field-encryption.js';
import { BaseEntity } from './base.entity.js';
import { JobApplication } from './job-application.entity.js';

export enum InterviewStatus {
  SCHEDULED = 'scheduled',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  NO_SHOW = 'no_show',
}

export type InterviewAttachment = {
  // Object key in the private bucket.
  key: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

@Entity({ name: 'interviews' })
export class Interview extends BaseEntity {
  @ManyToOne(() => JobApplication, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'application_id' })
  application!: Relation<JobApplication>;

  @Index()
  @Column({ name: 'application_id', type: 'uuid' })
  applicationId!: string;

  // e.g. "Tech interview", "Behavioural interview".
  @Column({ type: 'varchar', length: 120, default: 'Interview' })
  title!: string;

  @Index()
  @Column({ type: 'timestamptz' })
  startsAt!: Date;

  @Column({ type: 'int' })
  durationMinutes!: number;

  // Optional: take-home tasks have no meeting.
  @Column({ type: 'varchar', length: 500, nullable: true })
  meetingUrl!: string | null;

  // Files sent to the candidate with the invitation, e.g. a take-home task PDF.
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  attachments!: InterviewAttachment[];

  @Column({ type: 'text', nullable: true, transformer: encrypted })
  notes!: string | null;

  @Column({ type: 'enum', enum: InterviewStatus, default: InterviewStatus.SCHEDULED })
  status!: InterviewStatus;

  @ManyToOne(() => AdminUser, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by_id' })
  createdBy!: Relation<AdminUser> | null;

  @Column({ name: 'created_by_id', type: 'uuid', nullable: true })
  createdById!: string | null;
}
