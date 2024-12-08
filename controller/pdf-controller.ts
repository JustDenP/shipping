import { Controller, Get, Param, Res, Query } from '@nestjs/common';
import { Ctx, RequestContext, Fulfillment, TransactionalConnection, Allow, Permission } from '@vendure/core';
import { In } from 'typeorm';
import { Response } from 'express';
import { PdfWriterService } from '../services/pdf-writer-service';

@Controller('v-admin-api/pdf-api')
export class PdfController {
    constructor(private connection: TransactionalConnection, private pdfWriterService: PdfWriterService) {}

    @Get('packing/:id')
    @Allow(Permission.ReadOrder)
    async generatePackingSlip(
        @Param('id') id: string,
        @Ctx() ctx: RequestContext,
        @Res() res: Response,
        @Query('lbl') includeLabel: string,
        @Query('slip') includeSlip: string,
    ) {
        try {
            const idList = id.split(',').filter(i => i.trim());
            const fulfillments = await this.connection.getRepository(ctx, Fulfillment).find({
                where: { id: In(idList) },
                relations: [
                    'orders',
                    'orders.customer',
                    'lines.orderLine',
                    'lines.orderLine.productVariant',
                    'lines.orderLine.productVariant.translations',
                ],
            });
            // Sort fulfillments by the order in idList
            fulfillments.sort((a, b) => idList.indexOf(a.id.toString()) - idList.indexOf(b.id.toString()));

            if (!fulfillments.length) {
                return res.status(404).send('Fulfillment(s) not found');
            }

            const pdfBuffer = await this.pdfWriterService.createMultipleDocuments(fulfillments, {
                includePackingSlip: includeSlip !== 'false',
                includeShippingLabel: includeLabel !== 'false',
            });

            res.set({
                'Content-Type': 'application/pdf',
                'Content-Length': pdfBuffer.length,
            });

            res.status(200).send(Buffer.from(pdfBuffer));
        } catch (error) {
            console.error('Error generating PDF:', error, error?.stack);
            res.status(500).send('Error generating PDF');
        }
    }

    // Pick list API
    @Get('picklist/:id')
    @Allow(Permission.ReadOrder)
    async generatePickList(@Param('id') id: string, @Ctx() ctx: RequestContext, @Res() res: Response) {
        try {
            const idList = id.split(',').filter(i => i.trim());
            const fulfillments = await this.connection.getRepository(ctx, Fulfillment).find({
                where: { id: In(idList) },
                relations: [
                    'orders',
                    'orders.customer',
                    'lines.orderLine',
                    'lines.orderLine.productVariant',
                    'lines.orderLine.productVariant.translations',
                ],
            });

            if (!fulfillments.length) {
                return res.status(404).send('Fulfillment(s) not found');
            }

            const pdfBuffer = await this.pdfWriterService.createPickListPdf(fulfillments);

            res.set({
                'Content-Type': 'application/pdf',
                'Content-Length': pdfBuffer.length,
            });

            res.status(200).send(Buffer.from(pdfBuffer));
        } catch (error) {
            console.error('Error generating PDF:', error, error?.stack);
            res.status(500).send('Error generating PDF');
        }
    }
}
