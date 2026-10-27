import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { BaseEntity } from './base.entity.js';
import { Locale } from './enums.js';
import { Job } from './job.entity.js';

@Entity({ name: 'job_translations' })
@Index(['jobId', 'locale'], { unique: true })
export class JobTranslation extends BaseEntity {
  @ManyToOne(() => Job, (job) => job.translations, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'job_id' })
  job!: Relation<Job>;

  @Column({ name: 'job_id', type: 'uuid' })
  jobId!: string;

  @Column({ type: 'enum', enum: Locale })
  locale!: Locale;

  @Column({ type: 'varchar', length: 160 })
  title!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  activities!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  importantPoints!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  requirements!: string[];
}
