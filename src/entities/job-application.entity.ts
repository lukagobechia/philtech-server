import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  type Relation,
} from 'typeorm';
import { encrypted } from '../lib/field-encryption.js';
import { BaseEntity } from './base.entity.js';
import { Locale } from './enums.js';
import { Job } from './job.entity.js';

export enum JobApplicationStatus {
  RECEIVED = 'received',
  REVIEWING = 'reviewing',
  INTERVIEW = 'interview',
  REJECTED = 'rejected',
  HIRED = 'hired',
}

@Entity({ name: 'job_applications' })
export class JobApplication extends BaseEntity {
  // Null once the job is deleted; jobCode and jobTitle keep the link.
  @Index()
  @ManyToOne(() => Job, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'job_id' })
  job!: Relation<Job> | null;

  @Column({ name: 'job_id', type: 'uuid', nullable: true })
  jobId!: string | null;

  // Snapshot of the opening at the time of applying.
  @Index()
  @Column({ type: 'varchar', length: 32 })
  jobCode!: string;

  @Column({ type: 'varchar', length: 160 })
  jobTitle!: string;

  @Column({ type: 'text', transformer: encrypted })
  firstName!: string;

  @Column({ type: 'text', transformer: encrypted })
  lastName!: string;

  @Column({ type: 'text', transformer: encrypted })
  city!: string;

  // ISO 3166-1 alpha-2
  @Column({ type: 'varchar', length: 2 })
  country!: string;

  @Column({ type: 'text', nullable: true, transformer: encrypted })
  currentEmployer!: string | null;

  @Column({ type: 'text', nullable: true, transformer: encrypted })
  currentPosition!: string | null;

  @Column({ type: 'text', transformer: encrypted })
  email!: string;

  // E.164
  @Column({ type: 'text', transformer: encrypted })
  phone!: string;

  // Blind index for admin search over the encrypted fields, set on save; never returned.
  @Index('IDX_job_applications_search_index', { synchronize: false })
  @Column({ type: 'text', array: true, default: () => "'{}'", select: false })
  searchIndex!: string[];

  // Object key in the private resume bucket, never a public URL.
  @Column({ type: 'varchar', length: 500 })
  resumeKey!: string;

  @Column({ type: 'text', transformer: encrypted })
  resumeFileName!: string;

  @Column({ type: 'varchar', length: 100 })
  resumeMimeType!: string;

  @Column({ type: 'int' })
  resumeSizeBytes!: number;

  @Column({ type: 'timestamptz' })
  consentAt!: Date;

  @Column({ type: 'varchar', length: 32 })
  privacyPolicyVersion!: string;

  @Column({ type: 'enum', enum: Locale, default: Locale.EN })
  locale!: Locale;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ipHash!: string | null;

  @Index()
  @Column({
    type: 'enum',
    enum: JobApplicationStatus,
    default: JobApplicationStatus.RECEIVED,
  })
  status!: JobApplicationStatus;
}
