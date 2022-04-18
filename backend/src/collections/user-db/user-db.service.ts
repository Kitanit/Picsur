import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { SysPreference } from 'picsur-shared/dist/dto/sys-preferences.dto';
import {
  AsyncFailable,
  Fail,
  HasFailed,
  HasSuccess
} from 'picsur-shared/dist/types';
import { makeUnique } from 'picsur-shared/dist/util/unique';
import { Repository } from 'typeorm';
import { Permissions } from '../../models/constants/permissions.const';
import {
  DefaultRolesList,
  SoulBoundRolesList
} from '../../models/constants/roles.const';
import {
  ImmutableUsersList,
  LockedLoginUsersList,
  UndeletableUsersList
} from '../../models/constants/special-users.const';
import { EUserBackend } from '../../models/entities/user.entity';
import { GetCols } from '../../models/util/collection';
import { SysPreferenceService } from '../preference-db/sys-preference-db.service';
import { RolesService } from '../role-db/role-db.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger('UsersService');

  constructor(
    @InjectRepository(EUserBackend)
    private usersRepository: Repository<EUserBackend>,
    private rolesService: RolesService,
    private prefService: SysPreferenceService,
  ) {}

  // Creation and deletion

  public async create(
    username: string,
    password: string,
    roles?: string[],
    // Add option to create "invalid" users, should only be used by system
    byPassRoleCheck?: boolean,
  ): AsyncFailable<EUserBackend> {
    if (await this.exists(username)) return Fail('User already exists');

    const strength = await this.getBCryptStrength();
    const hashedPassword = await bcrypt.hash(password, strength);

    let user = new EUserBackend();
    user.username = username;
    user.hashedPassword = hashedPassword;
    if (byPassRoleCheck) {
      const rolesToAdd = roles ?? [];
      user.roles = makeUnique(rolesToAdd);
    } else {
      // Strip soulbound roles and add default roles
      const rolesToAdd = this.filterAddedRoles(roles ?? []);
      user.roles = makeUnique([...DefaultRolesList, ...rolesToAdd]);
    }

    try {
      return await this.usersRepository.save(user);
    } catch (e) {
      return Fail(e);
    }
  }

  public async delete(uuid: string): AsyncFailable<EUserBackend> {
    const userToModify = await this.findOne(uuid);
    if (HasFailed(userToModify)) return userToModify;

    if (UndeletableUsersList.includes(userToModify.username)) {
      return Fail('Cannot delete system user');
    }

    try {
      return await this.usersRepository.remove(userToModify);
    } catch (e) {
      return Fail(e);
    }
  }

  // Updating

  public async setRoles(
    uuid: string,
    roles: string[],
  ): AsyncFailable<EUserBackend> {
    const userToModify = await this.findOne(uuid);
    if (HasFailed(userToModify)) return userToModify;

    if (ImmutableUsersList.includes(userToModify.username)) {
      // Just fail silently
      this.logger.verbose("User tried to modify system user, failed silently");
      return userToModify;
    }

    const rolesToKeep = userToModify.roles.filter((role) =>
      SoulBoundRolesList.includes(role),
    );
    const rolesToAdd = this.filterAddedRoles(roles);
    const newRoles = makeUnique([...rolesToKeep, ...rolesToAdd]);
    userToModify.roles = newRoles;

    try {
      return await this.usersRepository.save(userToModify);
    } catch (e) {
      return Fail(e);
    }
  }

  public async removeRoleEveryone(role: string): AsyncFailable<true> {
    try {
      await this.usersRepository
        .createQueryBuilder('user')
        .update()
        .set({
          roles: () => 'ARRAY_REMOVE(roles, :role)',
        })
        .where('roles @> ARRAY[:role]', { role })
        .execute();
    } catch (e) {
      return Fail(e);
    }

    return true;
  }

  public async getPermissions(uuid: string): AsyncFailable<Permissions> {
    const userToModify = await this.findOne(uuid);
    if (HasFailed(userToModify)) return userToModify;

    return await this.rolesService.getPermissions(userToModify.roles);
  }

  public async updatePassword(
    uuid: string,
    password: string,
  ): AsyncFailable<EUserBackend> {
    let userToModify = await this.findOne(uuid);
    if (HasFailed(userToModify)) return userToModify;

    const strength = await this.getBCryptStrength();
    userToModify.hashedPassword = await bcrypt.hash(password, strength);

    try {
      userToModify = await this.usersRepository.save(userToModify);
    } catch (e) {
      return Fail(e);
    }

    return userToModify;
  }

  // Authentication

  async authenticate(
    username: string,
    password: string,
  ): AsyncFailable<EUserBackend> {
    const user = await this.findByUsername(username, true);
    if (HasFailed(user)) return user;

    if (LockedLoginUsersList.includes(user.username)) {
      // Error should be kept in backend
      return Fail('Wrong username');
    }

    if (!(await bcrypt.compare(password, user.hashedPassword ?? '')))
      return Fail('Wrong password');

    return await this.findOne(user.id ?? '');
  }

  // Listing

  public async findByUsername(
    username: string,
    // Also fetch fields that aren't normally sent to the client
    // (e.g. hashed password)
    getPrivate: boolean = false,
  ): AsyncFailable<EUserBackend> {
    try {
      const found = await this.usersRepository.findOne({
        where: { username },
        select: getPrivate ? GetCols(this.usersRepository) : undefined,
      });

      if (!found) return Fail('User not found');
      return found;
    } catch (e) {
      return Fail(e);
    }
  }

  public async findOne(uuid: string): AsyncFailable<EUserBackend> {
    try {
      const found = await this.usersRepository.findOne({
        where: { id: uuid },
      });

      if (!found) return Fail('User not found');
      return found as EUserBackend;
    } catch (e) {
      return Fail(e);
    }
  }

  public async findMany(
    count: number,
    page: number,
  ): AsyncFailable<EUserBackend[]> {
    if (count < 1 || page < 0) return Fail('Invalid page');
    if (count > 100) return Fail('Too many results');

    try {
      return await this.usersRepository.find({
        take: count,
        skip: count * page,
      });
    } catch (e) {
      return Fail(e);
    }
  }

  public async exists(username: string): Promise<boolean> {
    return HasSuccess(await this.findByUsername(username));
  }

  // Internal

  private filterAddedRoles(roles: string[]): string[] {
    const filteredRoles = roles.filter(
      (role) => !SoulBoundRolesList.includes(role),
    );

    return filteredRoles;
  }

  private async getBCryptStrength(): Promise<number> {
    const result = await this.prefService.getNumberPreference(
      SysPreference.BCryptStrength,
    );
    if (HasFailed(result)) {
      return 12;
    }
    return result;
  }
}
