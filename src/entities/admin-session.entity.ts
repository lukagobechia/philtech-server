import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AdminUser } from './admin-user.entity.js';
import { BaseEntity } from './base.entity.js';

@Entity({ name: 'admin_sessions' })
export class AdminSession extends BaseEntity {
  // sha256 of the opaque cookie token; the raw token is never stored.
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  tokenHash!: string;

  @ManyToOne(() => AdminUser, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'admin_user_id' })
  adminUser!: Relation<AdminUser>;

  @Index()
  @Column({ name: 'admin_user_id', type: 'uuid' })
  adminUserId!: string;

  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz' })
  lastSeenAt!: Date;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ipHash!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent!: string | null;
}
