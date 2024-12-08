import { ChangeDetectionStrategy, Component, Injector } from '@angular/core';
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker';
import { map, take } from 'rxjs/operators';
import { SortOrder, TypedBaseListComponent } from '@vendure/admin-ui/core';
import {
    GetPickupsQuery,
    GetPickupsDocument,
    PickupListOptions,
    LogicalOperator,
} from '../../generated-types';
import { Router } from '@angular/router';

type PickupObj = GetPickupsQuery['pickups']['items'][number];

@Component({
    selector: 'ep-pickup-list',
    templateUrl: './pickup-list.component.html',
    styleUrls: ['./pickup-list.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PickupListComponent extends TypedBaseListComponent<typeof GetPickupsDocument, 'pickups'> {
    customFields = this.getCustomFieldConfig('Pickup');
    selectedPickup$ = this.selectionManager.selectionChanges$.pipe(
        map(selection => (selection.length === 1 ? (selection[0] as PickupObj) : null)),
    );

    constructor(private injector: Injector, protected router: Router) {
        super();
        super.configure({
            document: GetPickupsDocument,
            getItems: data => data.pickups,
            setVariables: (skip, take) => this.createQueryOptions(skip, take, this.searchTermControl.value),
            refreshListOnChanges: [this.filters.valueChanges, this.sorts.valueChanges],
        });
        this.sorts.defaultSort('createdAt', SortOrder.DESC);
        this.route.queryParamMap.pipe(take(1)).subscribe(params => {
            const perPage = params.get('perPage') || '100';
            this.setItemsPerPage(+perPage);
        });
    }

    readonly filters = this.createFilterCollection()
        .addDateFilters()
        .addFilter({
            name: 'state',
            type: { kind: 'text' },
            label: 'State',
            filterField: 'state',
        })
        .connectToRoute(this.route);

    readonly sorts = this.createSortCollection()
        .addSort({ name: 'createdAt' })
        .addSort({ name: 'updatedAt' })
        .addSort({ name: 'carrier' })
        .connectToRoute(this.route);

    navigateToPickupDetail(id: string) {
        this.router.navigate([`./${id}`], { relativeTo: this.route });
    }

    private createQueryOptions(
        // eslint-disable-next-line @typescript-eslint/no-shadow
        skip: number,
        take: number,
        searchTerm: string | null,
    ): { options: PickupListOptions } {
        let filterInput = this.filters.createFilterInput();
        if (searchTerm) {
            filterInput = {
                carrier: {
                    contains: searchTerm,
                },
            };
        }
        return {
            options: {
                skip,
                take,
                filter: {
                    ...(filterInput ?? {}),
                },
                filterOperator: searchTerm ? LogicalOperator.OR : LogicalOperator.AND,
                sort: this.sorts.createSortInput(),
            },
        };
    }
}
