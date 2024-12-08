import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, ViewChild } from '@angular/core';
import { Dialog } from '@vendure/admin-ui/core';

@Component({
    selector: 'ep-edit-string-dialog',
    templateUrl: './edit-string-dialog.component.html',
    styleUrls: ['./edit-string-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditStringDialogComponent implements AfterViewInit, Dialog<string> {
    resolveWith: (result?: string) => void;

    label: string;
    value: string;
    @ViewChild('input') input: ElementRef;

    cancel() {
        this.resolveWith(void 0);
    }

    ngAfterViewInit(): void {
        setTimeout(() => this.input.nativeElement.focus(), 0);
    }
}
