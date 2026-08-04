export class TorrentDownloadDto {
  magnet_link!: string;
  file_name?: string;
  file_id?: string;
  file_indices?: number[];
}
