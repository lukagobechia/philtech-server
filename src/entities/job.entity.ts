import { Column, Entity, Index, OneToMany, type Relation } from 'typeorm';
import { BaseEntity } from './base.entity.js';
import { JobTranslation } from './job-translation.entity.js';

export enum JobEmploymentType {
  FULL_TIME = 'full_time',
  PART_TIME = 'part_time',
  CONTRACT = 'contract',
  INTERNSHIP = 'internship',
}

export enum JobCategory {
  IT = 'it',
  DIGITAL = 'digital',
  OTHER = 'other',
}

export enum JobLocation {
  TBILISI = 'tbilisi',
  BATUMI = 'batumi',
  REMOTE = 'remote',
}

@Entity({ name: 'jobs' })
@Index(['isPublished', 'category', 'location'])
export class Job extends BaseEntity {
  // Permanent reference for the opening (e.g. IT-2026-007). Copied onto every
  // application so it outlives archiving or deleting the job; never reused.
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 120 })
  slug!: string;

  @Column({ type: 'enum', enum: JobCategory })
  category!: JobCategory;

  @Column({ type: 'enum', enum: JobLocation })
  location!: JobLocation;

  @Column({ type: 'enum', enum: JobEmploymentType })
  employmentType!: JobEmploymentType;

  @Column({ type: 'date', nullable: true })
  applicationDeadline!: string | null;

  @Column({ type: 'boolean', default: false })
  isPublished!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  // Set while the job waits to be posted; the scheduler publishes it at this time.
  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  publishAt!: Date | null;

  // Archived openings are hidden from the site and closed to applications.
  @Column({ type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;

  @OneToMany(() => JobTranslation, (translation) => translation.job, {
    cascade: true,
  })
  translations!: Relation<JobTranslation>[];
}
