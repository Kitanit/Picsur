import {
  Controller,
  Get,
  Head,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import {
  ImageMetaResponse,
  ImageRequestParams,
  ImageUploadResponse,
} from 'picsur-shared/dist/dto/api/image.dto';
import { HasFailed } from 'picsur-shared/dist/types';
import { UsersService } from '../../collections/user-db/user-db.service';
import { ImageFullIdParam } from '../../decorators/image-id/image-full-id.decorator';
import { ImageIdParam } from '../../decorators/image-id/image-id.decorator';
import { MultiPart } from '../../decorators/multipart/multipart.decorator';
import { RequiredPermissions } from '../../decorators/permissions.decorator';
import { ReqUserID } from '../../decorators/request-user.decorator';
import { Returns } from '../../decorators/returns.decorator';
import { ImageManagerService } from '../../managers/image/image.service';
import { ImageFullId } from '../../models/constants/image-full-id.const';
import { Permission } from '../../models/constants/permissions.const';
import { ImageUploadDto } from '../../models/dto/image-upload.dto';
import { EUserBackend2EUser } from '../../models/transformers/user.transformer';

// This is the only controller with CORS enabled
@Controller('i')
@RequiredPermissions(Permission.ImageView)
export class ImageController {
  private readonly logger = new Logger('ImageController');

  constructor(
    private readonly imagesService: ImageManagerService,
    private readonly userService: UsersService,
  ) {}

  @Get(':id')
  async getImage(
    // Usually passthrough is for manually sending the response,
    // But we need it here to set the mime type
    @Res({ passthrough: true }) res: FastifyReply,
    @ImageFullIdParam() fullid: ImageFullId,
    @Query() params: ImageRequestParams,
  ): Promise<Buffer> {
    if (fullid.type === 'original') {
      const image = await this.imagesService.getOriginal(fullid.id);
      if (HasFailed(image)) {
        this.logger.warn(image.getReason());
        throw new NotFoundException('Could not find image');
      }

      res.type(image.mime);
      return image.data;
    }

    const image = await this.imagesService.getConverted(
      fullid.id,
      fullid.mime,
      params,
    );
    if (HasFailed(image)) {
      this.logger.warn(image.getReason());
      throw new NotFoundException('Failed to get image');
    }

    res.type(image.mime);
    return image.data;
  }

  @Head(':id')
  async headImage(
    @Res({ passthrough: true }) res: FastifyReply,
    @ImageFullIdParam() fullid: ImageFullId,
  ) {
    if (fullid.type === 'original') {
      const fullmime = await this.imagesService.getOriginalMime(fullid.id);
      if (HasFailed(fullmime)) {
        this.logger.warn(fullmime.getReason());
        throw new NotFoundException('Could not find image');
      }

      res.type(fullmime.mime);
      return;
    }

    res.type(fullid.mime);
  }

  @Get('meta/:id')
  @Returns(ImageMetaResponse)
  async getImageMeta(@ImageIdParam() id: string): Promise<ImageMetaResponse> {
    const image = await this.imagesService.retrieveInfo(id);
    if (HasFailed(image)) {
      this.logger.warn(image.getReason());
      throw new NotFoundException('Could not find image');
    }

    const [fileMimes, imageUser] = await Promise.all([
      this.imagesService.getAllFileMimes(id),
      this.userService.findOne(image.user_id),
    ]);
    if (HasFailed(fileMimes)) {
      this.logger.warn(fileMimes.getReason());
      throw new InternalServerErrorException('Could not get image mime');
    }
    if (HasFailed(imageUser)) {
      this.logger.warn(imageUser.getReason());
      throw new InternalServerErrorException('Could not get image user');
    }

    return { image, user: EUserBackend2EUser(imageUser), fileMimes };
  }

  @Post()
  @Returns(ImageUploadResponse)
  @RequiredPermissions(Permission.ImageUpload)
  async uploadImage(
    @MultiPart() multipart: ImageUploadDto,
    @ReqUserID() userid: string,
  ): Promise<ImageUploadResponse> {
    const image = await this.imagesService.upload(
      multipart.image.buffer,
      userid,
    );
    if (HasFailed(image)) {
      this.logger.warn(image.getReason(), image.getStack());
      throw new InternalServerErrorException('Could not upload image');
    }

    return image;
  }
}
