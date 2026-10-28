import nodemailer from 'nodemailer';
import { sms } from 'tencentcloud-sdk-nodejs-sms';

export type CodeMessage = { recipient: string; channel: 'email' | 'sms'; purpose: 'register' | 'login' | 'reset'; code: string; expiresIn: number };
export type DeliveryConfig = {
    SMTP_HOST?: string; SMTP_PORT?: number; SMTP_USER?: string; SMTP_PASSWORD?: string; SMTP_FROM?: string;
    TENCENT_SMS_SECRET_ID?: string; TENCENT_SMS_SECRET_KEY?: string; TENCENT_SMS_APP_ID?: string;
    TENCENT_SMS_SIGN_NAME?: string; TENCENT_SMS_TEMPLATE_ID?: string; TENCENT_SMS_REGION?: string;
};

const subjects = { register: '注册验证码', login: '登录验证码', reset: '重置密码验证码' };

export function createCodeDelivery(config: DeliveryConfig) {
    const emailReady = !!(config.SMTP_HOST && config.SMTP_PORT && config.SMTP_USER && config.SMTP_PASSWORD && config.SMTP_FROM);
    const smsReady = !!(config.TENCENT_SMS_SECRET_ID && config.TENCENT_SMS_SECRET_KEY && config.TENCENT_SMS_APP_ID && config.TENCENT_SMS_SIGN_NAME && config.TENCENT_SMS_TEMPLATE_ID);
    const mailer = emailReady ? nodemailer.createTransport({
        host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_PORT === 465,
        requireTLS: config.SMTP_PORT !== 465, auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
    }) : undefined;
    const smsClient = smsReady ? new sms.v20210111.Client({
        credential: { secretId: config.TENCENT_SMS_SECRET_ID!, secretKey: config.TENCENT_SMS_SECRET_KEY! },
        region: config.TENCENT_SMS_REGION || 'ap-guangzhou',
        profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com', reqTimeout: 15 } }
    }) : undefined;

    return {
        available: (channel: CodeMessage['channel']) => channel === 'email' ? emailReady : smsReady,
        async send(message: CodeMessage) {
            const minutes = Math.ceil(message.expiresIn / 60);
            if (message.channel === 'email' && mailer) {
                await mailer.sendMail({ from: config.SMTP_FROM, to: message.recipient,
                    subject: subjects[message.purpose],
                    text: `您的${subjects[message.purpose]}是 ${message.code}，${minutes} 分钟内有效。若非本人操作，请忽略此邮件。` });
                return;
            }
            if (message.channel === 'sms' && smsClient) {
                const result = await smsClient.SendSms({ SmsSdkAppId: config.TENCENT_SMS_APP_ID!,
                    SignName: config.TENCENT_SMS_SIGN_NAME!, TemplateId: config.TENCENT_SMS_TEMPLATE_ID!,
                    TemplateParamSet: [message.code, String(minutes)], PhoneNumberSet: [message.recipient] });
                if (result.SendStatusSet?.length !== 1 || result.SendStatusSet[0].Code !== 'Ok') throw new Error('SMS provider rejected delivery');
                return;
            }
            throw new Error('Delivery channel is not configured');
        }
    };
}
