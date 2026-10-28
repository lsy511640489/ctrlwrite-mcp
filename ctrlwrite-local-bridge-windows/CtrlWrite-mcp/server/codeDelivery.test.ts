import assert from 'node:assert/strict';
import { test } from 'node:test';
import nodemailer from 'nodemailer';
import { sms } from 'tencentcloud-sdk-nodejs-sms';
import { createCodeDelivery } from './codeDelivery';

test('built-in delivery sends email and SMS using configured providers', async context => {
    const emailMessages: unknown[] = [];
    const smsRequests: unknown[] = [];
    context.mock.method(nodemailer, 'createTransport', () => ({
        sendMail: async (message: unknown) => { emailMessages.push(message); }
    }) as unknown as ReturnType<typeof nodemailer.createTransport>);
    context.mock.method(sms.v20210111, 'Client', function FakeSmsClient() {
        return { SendSms: async (request: unknown) => {
            smsRequests.push(request);
            return { SendStatusSet: [{ Code: 'Ok' }] };
        } };
    } as unknown as typeof sms.v20210111.Client);

    const delivery = createCodeDelivery({ SMTP_HOST: 'smtp.test', SMTP_PORT: 465, SMTP_USER: 'writer',
        SMTP_PASSWORD: 'secret', SMTP_FROM: 'writer@example.com', TENCENT_SMS_SECRET_ID: 'id',
        TENCENT_SMS_SECRET_KEY: 'key', TENCENT_SMS_APP_ID: 'app', TENCENT_SMS_SIGN_NAME: '测试签名',
        TENCENT_SMS_TEMPLATE_ID: 'template' });
    assert.equal(delivery.available('email'), true);
    assert.equal(delivery.available('sms'), true);
    await delivery.send({ recipient: 'reader@example.com', channel: 'email', purpose: 'register', code: '123456', expiresIn: 300 });
    await delivery.send({ recipient: '+8613812345678', channel: 'sms', purpose: 'reset', code: '654321', expiresIn: 300 });
    assert.deepEqual(emailMessages, [{ from: 'writer@example.com', to: 'reader@example.com',
        subject: '注册验证码', text: '您的注册验证码是 123456，5 分钟内有效。若非本人操作，请忽略此邮件。' }]);
    assert.deepEqual(smsRequests, [{ SmsSdkAppId: 'app', SignName: '测试签名', TemplateId: 'template',
        TemplateParamSet: ['654321', '5'], PhoneNumberSet: ['+8613812345678'] }]);
});

test('delivery rejects missing channels and SMS provider failures', async context => {
    context.mock.method(sms.v20210111, 'Client', function FakeSmsClient() {
        return { SendSms: async () => ({ SendStatusSet: [{ Code: 'Failed' }] }) };
    } as unknown as typeof sms.v20210111.Client);
    const delivery = createCodeDelivery({ TENCENT_SMS_SECRET_ID: 'id', TENCENT_SMS_SECRET_KEY: 'key',
        TENCENT_SMS_APP_ID: 'app', TENCENT_SMS_SIGN_NAME: '测试签名', TENCENT_SMS_TEMPLATE_ID: 'template' });
    assert.equal(delivery.available('email'), false);
    assert.equal(delivery.available('sms'), true);
    await assert.rejects(delivery.send({ recipient: '+8613812345678', channel: 'sms', purpose: 'login', code: '123456', expiresIn: 300 }), /rejected/);
});
