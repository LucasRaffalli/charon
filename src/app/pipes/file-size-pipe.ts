import { Pipe, PipeTransform } from '@angular/core';

const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'] as const;

/** Formate une taille en octets de façon lisible : 1234567 → « 1,2 Mo ». */
@Pipe({ name: 'fileSize' })
export class FileSizePipe implements PipeTransform {
  transform(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} ${UNITS[0]}`;
    }
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(1)} ${UNITS[unit]}`;
  }
}
